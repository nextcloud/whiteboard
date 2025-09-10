/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import Utils from './Utils.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import Config from './Config.js'
import RecordingService from './RecordingService.js'

export default class SocketManager {

	#getRecordingKey(roomId, userId) {
		return `${roomId}_${userId}`
	}

	// Debug method to check recording services state
	debugRecordingServices() {
		console.log('Active recording services:', Array.from(this.recordingServices.keys()))
		return this.recordingServices
	}

	// Debug method to check presentation sessions state
	debugPresentationSessions() {
		console.log('Active presentation sessions:', Array.from(this.presentationSessions.entries()))
		return this.presentationSessions
	}

	constructor(server, socketDataStorage, cachedTokenStorage, redisClient) {
		this.socketDataStorage = socketDataStorage
		this.cachedTokenStorage = cachedTokenStorage
		this.redisClient = redisClient
		this.recordingServices = new Map()
		// Track presentation state per room: roomId -> { presenterId, presenterName, startTime }
		this.presentationSessions = new Map()
		this.io = this.createSocketServer(server)
		this.init()
	}

	createSocketServer(server) {
		const socketOptions = {
			transports: ['websocket', 'polling'],
			maxHttpBufferSize: Config.MAX_UPLOAD_FILE_SIZE + 1e6,
			cors: {
				origin: Config.CORS_ORIGINS,
				methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				credentials: true,
			},
		}

		// Add per-message deflate compression if enabled
		if (Config.COMPRESSION_ENABLED) {
			socketOptions.perMessageDeflate = {
				threshold: 1024, // Only compress messages larger than 1KB
				zlibDeflateOptions: {
					level: 6, // Medium compression level
					memLevel: 8, // Memory level for optimal speed
					windowBits: 15, // Window size
				},
				zlibInflateOptions: {
					windowBits: 15, // Window size
				},
			}
			console.log('WebSocket compression enabled')
		} else {
			console.log('WebSocket compression disabled')
		}

		return new SocketIO(server, socketOptions)
	}

	async init() {
		await this.setupAdapter()
		this.setupEventHandlers()
	}

	async setupAdapter() {
		if (this.shouldUseRedis()) {
			await this.setupRedisStreamsAdapter()
		} else {
			console.log('Using default in-memory adapter')
		}
	}

	async setupRedisStreamsAdapter() {
		console.log('Setting up Redis Streams adapter')
		try {
			this.io.adapter(createAdapter(this.redisClient, { maxLen: 10000 }))
			console.log('Redis Streams adapter set up successfully')
		} catch (error) {
			console.error('Failed to set up Redis Streams adapter:', error)
			console.log('Falling back to in-memory adapter')
		}
	}

	shouldUseRedis() {
		return !!this.redisClient
	}

	async socketAuthenticateHandler(socket, next) {
		const { token, secret } = socket.handshake.auth

		try {
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			await this.socketDataStorage.set(socket.id, decodedData)

			next()
		} catch (error) {
			// Check if this is an admin connectivity test (has secret but no token)
			const isAdminConnectivityTest = !token && secret

			if (isAdminConnectivityTest) {
				console.debug(`[ADMIN] Connectivity test from socket ${socket.id}`)
			} else {
				console.debug(`[AUTH] Authentication failed for socket ${socket.id}: ${error.message}`)
			}

			await this.handleAuthError(socket, next)
		}
	}

	async handleAuthError(socket, next) {
		const { secret, token } = socket.handshake.auth
		const isAdminConnectivityTest = !token && secret

		try {
			jwt.verify(secret, Config.JWT_SECRET_KEY, { algorithm: 'HS256' })
			if (isAdminConnectivityTest) {
				console.debug(`[ADMIN] Connectivity test successful for socket ${socket.id}`)
			}
			next(new Error('Connection verified'))
		} catch (e) {
			if (isAdminConnectivityTest) {
				console.debug(`[ADMIN] Connectivity test failed for socket ${socket.id}: JWT secret mismatch`)
			}
			next(new Error('Authentication error'))
		}
	}

	async verifyToken(token) {
		const cachedToken = await this.cachedTokenStorage.get(token)

		if (cachedToken) return cachedToken

		return new Promise((resolve, reject) => {
			jwt.verify(token, Config.JWT_SECRET_KEY, async (err, decoded) => {
				if (err) {
					console.log(
						err.name === 'TokenExpiredError'
							? 'Token expired'
							: 'Token verification failed',
					)
					return reject(new Error('Authentication error'))
				}
				await this.cachedTokenStorage.set(token, decoded)
				resolve(decoded)
			})
		})
	}

	setupEventHandlers() {
		this.io.use(this.socketAuthenticateHandler.bind(this))

		// Setup basic Socket.io metrics
		prometheusMetrics(this.io)

		// Handle connections
		this.io.on('connection', this.handleConnection.bind(this))
	}

	handleConnection(socket) {
		console.log(`New socket connection: ${socket.id}`)

		// Store connection timestamp to help debug reconnection issues
		this.socketDataStorage.set(`${socket.id}:connected_at`, Date.now())

		// Setup event listeners for this socket before emitting any events
		this.setupSocketEventListeners(socket)

		// Emit init-room event to trigger client to join the room
		// This is the primary mechanism for initiating room joins
		// The client will respond to this event by calling join-room
		console.log(`Sending init-room event to socket ${socket.id}`)
		socket.emit('init-room')
	}

	setupSocketEventListeners(socket) {
		const events = {
			'join-room': this.joinRoomHandler,
			'server-broadcast': this.serverBroadcastHandler,
			'server-volatile-broadcast': this.serverVolatileBroadcastHandler,
			'image-get': this.imageGetHandler,
			'start-recording': this.startRecordingHandler,
			'stop-recording': this.stopRecordingHandler,
			'presentation-start': this.presentationStartHandler,
			'presentation-stop': this.presentationStopHandler,
			'request-presenter-viewport': this.requestPresenterViewportHandler,
			'follow-user': this.followUserHandler,
			'request-viewport': this.requestViewportHandler,
			'viewport-change': this.viewportChangeHandler,
			disconnect: this.disconnectHandler,
		}

		Object.entries(events).forEach(([event, handler]) => {
			socket.on(event, (...args) => {
				// Handle the event safely
				this.safeSocketHandler(socket, () => {
					return handler.apply(this, [socket, ...args])
				})
			})
		})

		socket.on('disconnecting', () => {
			const rooms = Array.from(socket.rooms).filter(
				(room) => room !== socket.id,
			)
			this.safeSocketHandler(socket, () =>
				this.disconnectingHandler(socket, rooms),
			)
		})
	}

	async joinRoomHandler(socket, roomID) {
		const socketData = await this.socketDataStorage.get(socket.id)
		if (!socketData || !socketData.user) {
			console.warn(`[${roomID}] Invalid socket data for socket ${socket.id}, rejecting join`)
			return
		}

		const userId = socketData.user.id
		const userName = socketData.user.name

		// Check if socket is already in this room to prevent duplicate joins
		if (socket.rooms.has(roomID)) {
			console.log(`[${roomID}] ${userName} already in room, skipping join`)
			return
		}

		console.log(`[${roomID}] ${userName} joined room`)

		// Join the room
		await socket.join(roomID)

		// Check if this user is already the syncer for this room
		const roomSyncerKey = `room:${roomID}:syncer`
		const currentSyncerUserId = await this.socketDataStorage.get(roomSyncerKey)
		const isReadOnly = await this.isSocketReadOnly(socket.id)

		let isSyncer = false

		// If this user is already the syncer, maintain status
		if (currentSyncerUserId === userId) {
			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: true,
				syncerFor: roomID,
			})

			isSyncer = true
			socket.emit('sync-designate', { isSyncer: true })
			console.log(`[${roomID}] User ${userName} reconnected as existing syncer`)
		} else if (!currentSyncerUserId && !isReadOnly) {
			await this.socketDataStorage.set(roomSyncerKey, userId)

			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: true,
				syncerFor: roomID,
			})

			isSyncer = true
			socket.emit('sync-designate', { isSyncer: true })
			console.log(`[${roomID}] Designated new syncer: ${userName}`)
		} else {
			// Not the syncer
			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: false,
			})

			isSyncer = false
			socket.emit('sync-designate', { isSyncer: false })
		}

		// Ensure the socket is fully added to the room before getting the user list
		// This small delay ensures the socket.io internal state is updated
		await new Promise(resolve => setTimeout(resolve, 10))

		// Get updated list of users in the room, including the newly joined user
		const roomUsers = await this.getUserSocketsAndIds(roomID)

		// Log the number of users in the room
		console.log(`[${roomID}] Room now has ${roomUsers.length} users`)

		// Notify all users in the room about the updated user list
		// Make sure we include the current user in the list
		if (roomUsers.length > 0) {
			this.io.to(roomID).emit('room-user-change', roomUsers)
		}

		// Notify all users in the room that a new user has joined
		// This will trigger the syncer to broadcast the current scene
		this.io.to(roomID).emit('user-joined', {
			userId,
			userName,
			socketId: socket.id,
			isSyncer,
		})

		// Check if there's an active presentation session and notify the new user
		const presentationSession = this.presentationSessions.get(roomID)
		if (presentationSession) {
			console.log(`[${roomID}] Notifying new user ${userName} about active presentation by ${presentationSession.presenterName}`)
			socket.emit('user-started-presenting', {
				userId: presentationSession.presenterId,
				username: presentationSession.presenterName,
			})
		}
	}

	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)
	}

	async serverVolatileBroadcastHandler(socket, roomID, encryptedData) {
		const payload = JSON.parse(
			Utils.convertArrayBufferToString(encryptedData),
		)

		if (payload.type === 'MOUSE_LOCATION') {
			const socketData = await this.socketDataStorage.get(socket.id)

			if (!socketData) return

			const eventData = {
				type: 'MOUSE_LOCATION',
				payload: {
					...payload.payload,
					user: socketData.user,
				},
			}

			socket.volatile.broadcast
				.to(roomID)
				.emit(
					'client-broadcast',
					Utils.convertStringToArrayBuffer(JSON.stringify(eventData)),
				)
		} else if (payload.type === 'VIEWPORT_UPDATE') {
			const socketData = await this.socketDataStorage.get(socket.id)

			if (!socketData) return

			const eventData = {
				type: 'VIEWPORT_UPDATE',
				payload: {
					...payload.payload,
					userId: socketData.user.id,
				},
			}

			console.log(`[${roomID}] Broadcasting viewport update from user ${socketData.user.id}:`, eventData.payload)

			socket.volatile.broadcast
				.to(roomID)
				.emit(
					'client-broadcast',
					Utils.convertStringToArrayBuffer(JSON.stringify(eventData)),
				)
		}
	}

	async imageGetHandler(socket, roomId, id) {
		// Allow even read-only users to request images
		if (!socket.rooms.has(roomId)) return

		try {
			console.log(`[${roomId}] ${socket.id} requested image ${id}`)

			// Create an image request message
			const requestData = {
				type: 'IMAGE_REQUEST',
				payload: { fileId: id },
			}

			// Broadcast the request to all other clients in the room
			socket.to(roomId).emit('client-broadcast',
				Utils.convertStringToArrayBuffer(JSON.stringify(requestData)))
		} catch (error) {
			console.error(`[${roomId}] Error handling image request ${id}:`, error)
		}
	}

	async disconnectHandler(socket) {
		try {
			await this.socketDataStorage.delete(socket.id)

			socket.removeAllListeners()

			if (socket.connected) {
				socket.disconnect(true)
			}

			Utils.logOperation('SOCKET', `Cleaned up socket: ${socket.id}`)
		} catch (error) {
			Utils.logError(
				'SOCKET',
				`Failed to cleanup socket: ${socket.id}`,
				error,
			)
		}
	}

	async disconnectingHandler(socket, rooms) {
		for (const roomID of rooms) {
			if (roomID === socket.id) continue

			const socketData = await this.socketDataStorage.get(socket.id)
			const userId = socketData?.user?.id
			const userName = socketData?.user?.name || 'Unknown'

			console.log(`[${roomID}] User ${userName} disconnecting`)

			// Check if user was syncer and if they have other active connections in the room
			const roomSyncerKey = `room:${roomID}:syncer`
			const currentSyncerUserId = await this.socketDataStorage.get(roomSyncerKey)
			const wasSyncer = currentSyncerUserId === userId

			if (wasSyncer) {
				// Check if the user has other connections in the room before finding a new syncer
				const userSockets = await this.getUserSocketsInRoom(roomID)
				const userStillConnected = userSockets
					.filter((s) => s.socketId !== socket.id)
					.some((s) => s.userId === userId)

				if (!userStillConnected) {
					console.log(`[${roomID}] Syncer disconnected (all sessions), finding new syncer`)
					await this.findNewSyncer(roomID)
				} else {
					console.log(`[${roomID}] Syncer disconnected but has other active connections, maintaining syncer status`)
				}
			}

			// Check if user was presenting and clean up presentation session
			const presentationSession = this.presentationSessions.get(roomID)
			if (presentationSession) {
				const isPublicSharingUser = userId.startsWith('shared_')
				let shouldEndPresentation = false

				if (presentationSession.presenterId === userId) {
					shouldEndPresentation = true
				} else if (isPublicSharingUser) {
					// For public sharing users, check if they're from the same token
					const userTokenPart = userId.split('_')[1]
					const presenterTokenPart = presentationSession.presenterId.split('_')[1]
					if (userTokenPart === presenterTokenPart) {
						shouldEndPresentation = true
					}
				}

				if (shouldEndPresentation) {
					console.log(`[${roomID}] Presenter ${userName} disconnected, ending presentation`)
					this.presentationSessions.delete(roomID)

					// Notify all participants that presentation ended
					socket.to(roomID).emit('user-stopped-presenting', {
						userId,
						username: userName,
					})
				}
			}

			const roomUsers = await this.getUserSocketsAndIds(roomID)
			socket.to(roomID).emit('room-user-change', roomUsers)
		}
	}

	async findNewSyncer(roomID) {
		const userSockets = await this.getUserSocketsInRoom(roomID)
		const roomSyncerKey = `room:${roomID}:syncer`

		console.log(`[${roomID}] Finding new syncer. Users in room: ${userSockets.length}`)

		if (userSockets.length === 0) {
			console.log(`[${roomID}] No users left in room, no syncer needed`)
			await this.socketDataStorage.delete(roomSyncerKey)
			return
		}

		// Group sockets by user ID
		const userMap = new Map()
		userSockets.forEach((s) => {
			if (!userMap.has(s.userId)) {
				userMap.set(s.userId, [])
			}
			userMap.get(s.userId).push(s)
		})

		// Try to find a non-readonly user to become syncer
		for (const [userId, sockets] of userMap.entries()) {
			// Check if any of the user's sockets is not read-only
			for (const socketInfo of sockets) {
				const isReadOnly = await this.isSocketReadOnly(socketInfo.socketId)

				if (!isReadOnly) {
					// Found an eligible user, make them the syncer
					await this.socketDataStorage.set(roomSyncerKey, userId)

					// Update all sockets for this user
					for (const s of sockets) {
						const socketData = await this.socketDataStorage.get(s.socketId)
						if (socketData) {
							await this.socketDataStorage.set(s.socketId, {
								...socketData,
								isSyncer: true,
								syncerFor: roomID,
							})

							// Get the actual socket instance to emit to it
							const socket = this.io.sockets.sockets.get(s.socketId)
							if (socket) {
								socket.emit('sync-designate', { isSyncer: true })
							}
						}
					}

					console.log(`[${roomID}] Promoted new syncer: ${sockets[0].userName}`)
					return
				}
			}
		}

		console.log(`[${roomID}] No eligible users found for syncer role`)
		await this.socketDataStorage.delete(roomSyncerKey)
	}

	async safeSocketHandler(socket, handler) {
		try {
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user) {
				socket.emit('error', 'Invalid session')
				socket.disconnect()
				return false
			}
			const result = await handler()
			return result
		} catch (error) {
			console.error('Socket handler error:', error)
			socket.emit('error', 'Internal server error')
			return false
		}
	}

	async isSocketReadOnly(socketId) {
		const socketData = await this.socketDataStorage.get(socketId)
		return socketData ? !!socketData.isFileReadOnly : false
	}

	/**
	 * Gets user sockets and IDs for a room (deduplicated by user ID)
	 * @param {string} roomID - Room identifier
	 * @return {Promise<Array<{socketId: string, user: object, userId: string, socketIds: string[]}>>}
	 */
	async getUserSocketsAndIds(roomID) {
		// Fetch all sockets in the room
		const sockets = await this.io.in(roomID).fetchSockets()

		// Log for debugging
		console.log(`[${roomID}] Fetched ${sockets.length} sockets for room-user-change event`)

		// Process each socket to get user data
		const socketResults = await Promise.all(
			sockets.map(async (s) => {
				const data = await this.socketDataStorage.get(s.id)
				if (!data?.user?.id) {
					console.warn(`Invalid socket data for socket ${s.id}`)
					return null
				}
				return {
					socketId: s.id,
					user: data.user,
					userId: data.user.id,
				}
			}),
		)

		// Filter out null entries
		const validSockets = socketResults.filter(Boolean)

		// Group sockets by user ID to deduplicate
		const userMap = new Map()
		validSockets.forEach((socketData) => {
			const existingUser = userMap.get(socketData.userId)
			if (existingUser) {
				// User already exists, just add this socket ID to their list
				existingUser.socketIds.push(socketData.socketId)
			} else {
				// New user, create entry with array of socket IDs
				userMap.set(socketData.userId, {
					socketId: socketData.socketId, // Keep first socket ID for compatibility
					user: socketData.user,
					userId: socketData.userId,
					socketIds: [socketData.socketId], // Array of all socket IDs for this user
				})
			}
		})

		// Convert map to array
		const deduplicatedUsers = Array.from(userMap.values())

		console.log(`[${roomID}] Returning ${deduplicatedUsers.length} unique users (from ${validSockets.length} sockets) for room-user-change event`)

		return deduplicatedUsers
	}

	/**
	 * Gets detailed socket information for users in a room
	 * @param {string} roomID - Room identifier
	 * @return {Promise<Array<{socketId: string, userId: string, userName: string}>>}
	 */
	async getUserSocketsInRoom(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(
			sockets.map(async (s) => {
				const data = await this.socketDataStorage.get(s.id)
				if (!data?.user?.id) {
					console.warn(`Invalid socket data for socket ${s.id}`)
					return null
				}
				return {
					socketId: s.id,
					userId: data.user.id,
					userName: data.user.name,
				}
			}),
		).then((results) => results.filter(Boolean))
	}

	/**
	 * Handles recording start requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Recording data containing fileId, recordingUrl, uploadToken
	 */
	async startRecordingHandler(socket, data) {
		const { fileId, recordingUrl, uploadToken } = data
		const roomID = fileId.toString()
		const sessionKey = `${roomID}_${socket.id}`

		try {
			// Validate input and permissions
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			// Check if recording already in progress
			const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
			if (this.recordingServices.has(recordingKey)) {
				throw new Error('Recording already in progress')
			}

			// Initialize recording service with client-provided URL
			const recorder = new RecordingService()
			console.log(`[${sessionKey}] Initializing recording at ${recordingUrl}`)

			if (!await recorder.init(recordingUrl, roomID, socketData.user.id)) {
				throw new Error('Recorder initialization failed')
			}

			// Start recording session
			console.log(`[${sessionKey}] Starting recording`)
			await recorder.startRecording(roomID, socketData.user.id)

			// Store recorder with upload token for later use
			this.recordingServices.set(recordingKey, { recorder, uploadToken })

			// Notify participants
			socket.emit('recording-started')
			socket.to(roomID).emit('user-started-recording', {
				userId: socketData.user.id,
				username: socketData.user.displayName,
			})

		} catch (error) {
			console.error(`[${sessionKey}] Start recording failed:`, error)
			socket.emit('recording-error', error.message)
		}
	}

	/**
	 * Handles recording stop requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 */
	async stopRecordingHandler(socket, roomID) {
		const sessionKey = `${roomID}_${socket.id}`
		try {
			// Validate session
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			// Retrieve recording instance
			const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
			console.log(`[${sessionKey}] Looking for recorder with key: ${recordingKey}`)
			const recordingService = this.recordingServices.get(recordingKey)
			if (!recordingService) {
				console.log(`[${sessionKey}] Available recording keys:`, Array.from(this.recordingServices.keys()))
				throw new Error('No active recording found')
			}

			const { recorder, uploadToken } = recordingService

			// Stop recording and cleanup
			console.log(`[${sessionKey}] Stopping recording`)
			const result = await recorder.stopRecording(roomID, socketData.user.id)
			await recorder.cleanup(roomID, socketData.user.id)
			this.recordingServices.delete(recordingKey)
			console.log(`[${sessionKey}] Removed recorder from services map`)

			console.log(`[${sessionKey}] Notifying participants of recording stop`)
			// Notify participants with recording data and upload token
			socket.emit('recording-stopped', {
				filePath: result.localPath,
				recordingData: result.recordingData,
				uploadToken,
				fileId: roomID,
			})
			console.log(`[${sessionKey}] Emitted recording-stopped to ${socketData.user.id}`)

			socket.to(roomID).emit('user-stopped-recording', {
				userId: socketData.user.id,
				username: socketData.user.displayName,
			})
			console.log(`[${sessionKey}] Emitted user-stopped-recording to room ${roomID}`)

			console.log(`[${sessionKey}] Stop recording completed successfully`)

		} catch (error) {
			console.error(`[${sessionKey}] Stop recording failed:`, error)
			console.error(`[${sessionKey}] Error stack:`, error.stack)
			socket.emit('recording-error', error.message)
		} finally {
			// Ensure cleanup even if errors occur
			const socketData = await this.socketDataStorage.get(socket.id)
			if (socketData?.user?.id) {
				const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
				if (this.recordingServices.has(recordingKey)) {
					const recordingService = this.recordingServices.get(recordingKey)
					if (recordingService?.recorder?.cleanup) {
						await recordingService.recorder.cleanup()
					}
					this.recordingServices.delete(recordingKey)
				}
			}
		}
	}

	/**
	 * Handles presentation start requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Presentation data containing fileId, userId
	 */
	async presentationStartHandler(socket, data) {
		const { fileId, userId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			// Validate input and permissions
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			// Verify the user ID matches the socket user
			// For public sharing users, the user ID format is: shared_{token}_{randomBytes}
			// We need to be more flexible with the validation
			const socketUserId = socketData.user.id
			const isPublicSharingUser = socketUserId.startsWith('shared_')

			console.log(`[${sessionKey}] User ID validation:`, {
				socketUserId,
				requestUserId: userId,
				isPublicSharingUser,
				match: socketUserId === userId,
			})

			// Use the authoritative user ID (prefer socket data for public sharing users)
			let authoritativeUserId = userId
			if (socketUserId !== userId) {
				// For public sharing users, the user ID might be regenerated on each request
				// but they should still be allowed to present if they have the same session
				if (!isPublicSharingUser) {
					throw new Error('User ID mismatch')
				}

				// For public sharing users, we'll use the socket user ID as the authoritative one
				console.log(`[${sessionKey}] Using socket user ID for public sharing user: ${socketUserId}`)
				authoritativeUserId = socketUserId
			}

			// Check if presentation already in progress
			if (this.presentationSessions.has(roomID)) {
				const currentSession = this.presentationSessions.get(roomID)
				// If the same user is trying to start again, allow it (might be a reconnection)
				if (currentSession.presenterId === authoritativeUserId) {
					console.log(`[${sessionKey}] User ${socketData.user.displayName} restarting their presentation`)
					// Update the session timestamp
					currentSession.startTime = Date.now()
					this.presentationSessions.set(roomID, currentSession)

					// Notify the presenter
					socket.emit('presentation-started')
					return // Exit early, no need to create new session
				} else {
					throw new Error(`Presentation already in progress by ${currentSession.presenterName}`)
				}
			}

			// Start presentation session
			const presenterName = socketData.user.displayName || socketData.user.name || 'Unknown User'
			const presentationSession = {
				presenterId: authoritativeUserId,
				presenterName,
				startTime: Date.now(),
			}

			console.log(`[${sessionKey}] Creating presentation session:`, presentationSession)

			this.presentationSessions.set(roomID, presentationSession)
			console.log(`[${sessionKey}] Started presentation by ${presenterName}`)

			// Notify the presenter
			console.log(`[${sessionKey}] Emitting presentation-started to presenter`)
			socket.emit('presentation-started')

			// Notify all other participants in the room
			console.log(`[${sessionKey}] Emitting user-started-presenting to room ${roomID}`)
			socket.to(roomID).emit('user-started-presenting', {
				userId: authoritativeUserId,
				username: presenterName,
			})

			console.log(`[${sessionKey}] Notified room about presentation start`)

		} catch (error) {
			console.error(`[${sessionKey}] Start presentation failed:`, error)
			socket.emit('presentation-error', error.message)
		}
	}

	/**
	 * Handles presentation stop requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Presentation data containing fileId
	 */
	async presentationStopHandler(socket, data) {
		const { fileId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			// Validate input and permissions
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			// Check if presentation exists and user is the presenter
			const presentationSession = this.presentationSessions.get(roomID)
			if (!presentationSession) {
				throw new Error('No active presentation found')
			}

			const socketUserId = socketData.user.id
			const isPublicSharingUser = socketUserId.startsWith('shared_')

			console.log(`[${sessionKey}] Stop presentation validation:`, {
				socketUserId,
				presenterId: presentationSession.presenterId,
				isPublicSharingUser,
				match: presentationSession.presenterId === socketUserId,
			})

			// For public sharing users, we need to be more flexible with presenter validation
			// since their user IDs might change between requests
			if (presentationSession.presenterId !== socketUserId) {
				if (!isPublicSharingUser) {
					throw new Error('Only the presenter can stop the presentation')
				}

				// For public sharing users, check if they're from the same session/token
				// by comparing the token part of the user ID
				const socketTokenPart = socketUserId.split('_')[1] // Extract token from shared_{token}_{random}
				const presenterTokenPart = presentationSession.presenterId.split('_')[1]

				if (socketTokenPart !== presenterTokenPart) {
					throw new Error('Only the presenter can stop the presentation')
				}

				console.log(`[${sessionKey}] Allowing public sharing user to stop presentation (same token)`)
			}

			// Stop presentation session
			const presenterName = socketData.user.displayName || socketData.user.name || 'Unknown User'
			this.presentationSessions.delete(roomID)
			console.log(`[${sessionKey}] Stopped presentation by ${presenterName}`)

			// Notify the presenter
			socket.emit('presentation-stopped')

			// Notify all other participants in the room
			socket.to(roomID).emit('user-stopped-presenting', {
				userId: socketData.user.id,
				username: presenterName,
			})

			console.log(`[${sessionKey}] Notified room about presentation stop`)

		} catch (error) {
			console.error(`[${sessionKey}] Stop presentation failed:`, error)
			socket.emit('presentation-error', error.message)
		}
	}

	/**
	 * Handles request for presenter's viewport
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Request data containing fileId
	 */
	async requestPresenterViewportHandler(socket, data) {
		const { fileId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			console.log(`[${sessionKey}] Presenter viewport requested`)

			// Check if there's an active presentation
			const presentationSession = this.presentationSessions.get(roomID)
			if (!presentationSession) {
				console.log(`[${sessionKey}] No active presentation found`)
				return
			}

			// Broadcast the request to all users in the room (including the presenter)
			// The presenter will respond with their viewport if they're still connected
			this.io.to(roomID).emit('request-presenter-viewport')

			console.log(`[${sessionKey}] Broadcast presenter viewport request to room ${roomID}`)
		} catch (error) {
			console.error(`[${sessionKey}] Request presenter viewport failed:`, error)
		}
	}

	/**
	 * Handles follow user requests from recording agents
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {string} targetUserId - User ID to follow
	 */
	async followUserHandler(socket, roomID, targetUserId) {
		const socketData = await this.socketDataStorage.get(socket.id)
		if (!socketData?.user?.id) {
			console.warn(`[${roomID}] Invalid socket data for follow-user request`)
			return
		}

		console.log(`[${roomID}] User ${socketData.user.id} wants to follow user ${targetUserId}`)

		// Store the follow relationship for this socket
		await this.socketDataStorage.set(`${socket.id}:following`, targetUserId)

		// Acknowledge the follow request
		socket.emit('follow-user-ack', { targetUserId, status: 'following' })
	}

	/**
	 * Handles viewport request events
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Request data containing fileId and userId
	 */
	async requestViewportHandler(socket, data) {
		const { fileId, userId } = data
		const roomID = fileId

		try {
			// Validate the requesting socket
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user?.id) {
				console.warn(`[${roomID}] Invalid socket data for viewport request`)
				return
			}

			console.log(`[${roomID}] User ${socketData.user.id} requesting viewport from user ${userId}`)

			// Find sockets for the target user in the room
			const userSockets = await this.getUserSocketsInRoom(roomID)
			const targetSockets = userSockets.filter(s => s.userId === userId)

			if (targetSockets.length > 0) {
				// Request viewport from the first socket of the target user
				const targetSocketId = targetSockets[0].socketId
				const targetSocket = this.io.sockets.sockets.get(targetSocketId)

				if (targetSocket) {
					// Ask the target user to send their viewport
					console.log(`[${roomID}] Requesting viewport from socket ${targetSocketId}`)
					targetSocket.emit('send-viewport-request', {
						requesterId: socketData.user.id,
						requesterSocketId: socket.id,
					})
				} else {
					console.warn(`[${roomID}] Target socket ${targetSocketId} not found`)
				}
			} else {
				console.warn(`[${roomID}] User ${userId} not found in room`)
			}
		} catch (error) {
			console.error(`[${roomID}] Error handling viewport request:`, error)
		}
	}

	/**
	 * Handles viewport change events (legacy support)
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {object} viewportData - Viewport data
	 */
	async viewportChangeHandler(socket, roomID, viewportData) {
		// This handler exists for compatibility but viewport updates
		// are now handled through serverVolatileBroadcastHandler
		console.debug(`[${roomID}] Legacy viewport change event received`)
	}

}
