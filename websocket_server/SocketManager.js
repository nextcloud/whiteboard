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

export default class SocketManager {

	constructor(server, socketDataStorage, cachedTokenStorage, redisClient) {
		this.socketDataStorage = socketDataStorage
		this.cachedTokenStorage = cachedTokenStorage
		this.redisClient = redisClient
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
		// Temporarily disable Redis Streams adapter due to hanging issues
		console.log('Using default in-memory adapter (Redis Streams adapter temporarily disabled)')
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
		try {
			const { token } = socket.handshake.auth
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			await this.socketDataStorage.set(socket.id, decodedData)

			next()
		} catch (error) {
			console.debug(`[AUTH] Authentication failed for socket ${socket.id}: ${error.message}`)
			await this.handleAuthError(socket, next)
		}
	}

	async handleAuthError(socket, next) {
		const { secret } = socket.handshake.auth
		try {
			jwt.verify(secret, Config.JWT_SECRET_KEY, { algorithm: 'HS256' })
			next(new Error('Connection verified'))
		} catch (e) {
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
	 * Gets user sockets and IDs for a room
	 * @param {string} roomID - Room identifier
	 * @return {Promise<Array<{socketId: string, user: object, userId: string}>>}
	 */
	async getUserSocketsAndIds(roomID) {
		// Fetch all sockets in the room
		const sockets = await this.io.in(roomID).fetchSockets()

		// Log for debugging
		console.log(`[${roomID}] Fetched ${sockets.length} sockets for room-user-change event`)

		// Process each socket to get user data
		return Promise.all(
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
		).then((results) => {
			// Filter out any null entries and log the final count
			const filteredResults = results.filter(Boolean)
			console.log(`[${roomID}] Returning ${filteredResults.length} valid users for room-user-change event`)
			return filteredResults
		})
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

}
