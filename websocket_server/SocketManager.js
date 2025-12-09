/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import Utils from './Utils.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import Config from './Config.js'
import RecordingService from './RecordingService.js'
import { checkPuppeteerAvailability } from './PuppeteerEnvironment.js'
import VotingManager from './VotingManager.js'
import { SOCKET_MSG } from '../src/shared/constants.js'
import DistributedState from './DistributedState.js'
import NodePresence from './NodePresence.js'
import ClusterState from './ClusterState.js'

export default class SocketManager {

	static HEARTBEAT_KEY_PREFIX = 'node:'

	static HEARTBEAT_TTL_MS = 15000

	#getRecordingKey(roomId, userId) {
		return `${roomId}_${userId}`
	}

	#getTimerKey(roomId) {
		return `room:${roomId}:timer`
	}

	#getVotingKey(roomId) {
		return `room:${roomId}:votings`
	}

	// Debug method to check recording services state
	debugRecordingServices() {
		console.log('Active recording services:', Array.from(this.recordingServices.keys()))
		return this.recordingServices
	}

	// Debug method to check presentation sessions state
	async debugPresentationSessions() {
		const keys = await this.distributedState.listValueKeys('room:*:presentation')
		const sessions = []
		for (const key of keys) {
			const value = await this.distributedState.getValue(key)
			sessions.push([key, value])
		}
		console.log('Active presentation sessions:', sessions)
		return sessions
	}

	constructor(server, socketDataStorage, cachedTokenStorage, redisClient) {
		this.socketDataStorage = socketDataStorage
		this.cachedTokenStorage = cachedTokenStorage
		this.redisClient = redisClient
		this.recordingServices = new Map()
		// Track timers per room: roomId -> { status, durationMs, remainingMs, endsAt, startedBy, timeoutId }
		this.timers = new Map()
		this.nodeId = process.env.WEBSOCKET_NODE_ID || process.env.HOSTNAME || `node-${crypto.randomUUID()}`
		this.shuttingDown = false
		this.nodePresence = new NodePresence(redisClient, {
			nodeId: this.nodeId,
			ttlMs: SocketManager.HEARTBEAT_TTL_MS,
			keyPrefix: SocketManager.HEARTBEAT_KEY_PREFIX,
		})
		this.stateSweepInterval = null
		this.distributedState = new DistributedState({
			redisClient,
			prefix: this.socketDataStorage?.strategy?.prefix || 'socket_',
			defaultTtlMs: Config.SESSION_TTL,
		})
		this.clusterState = new ClusterState({
			distributedState: this.distributedState,
			nodePresence: this.nodePresence,
			nodeId: this.nodeId,
			sessionTtl: Config.SESSION_TTL,
		})
		this.io = this.createSocketServer(server)
		this.votingManager = new VotingManager()
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

	async getPresentationSession(roomID) {
		return this.clusterState.getPresentation(roomID)
	}

	async setPresentationSession(roomID, session) {
		return this.clusterState.setPresentation(roomID, session)
	}

	async clearPresentationSession(roomID) {
		await this.clusterState.clearPresentation(roomID)
	}

	async getRecordingState(roomID) {
		return this.clusterState.getRecordingState(roomID)
	}

	async setRecordingEntry(roomID, userId, entry) {
		return this.clusterState.setRecordingEntry(roomID, userId, entry)
	}

	async getRecordingEntry(roomID, userId) {
		const state = await this.getRecordingState(roomID)
		return state[userId]
	}

	async removeRecordingEntry(roomID, userId) {
		return this.clusterState.removeRecordingEntry(roomID, userId)
	}

	async getRoomSyncer(roomID) {
		return this.clusterState.getSyncer(roomID)
	}

	async setRoomSyncer(roomID, userId) {
		await this.clusterState.setSyncer(roomID, userId)
	}

	async clearRoomSyncer(roomID) {
		await this.clusterState.clearSyncer(roomID)
	}

	async init() {
		await this.setupAdapter()
		await this.nodePresence.start()
		this.startStateSweeper()
		this.setupServerSideEvents()
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

	startStateSweeper() {
		if (!this.shouldUseRedis() || this.stateSweepInterval) {
			return
		}
		const intervalMs = Math.max(2000, Math.floor(SocketManager.HEARTBEAT_TTL_MS / 2))
		this.stateSweepInterval = setInterval(() => {
			this.runSweep().catch((error) => {
				console.error('Failed to sweep cluster state:', error)
			})
		}, intervalMs)
	}

	stopStateSweeper() {
		if (this.stateSweepInterval) {
			clearInterval(this.stateSweepInterval)
			this.stateSweepInterval = null
		}
	}

	async isNodeAlive(nodeId) {
		return this.nodePresence.isAlive(nodeId)
	}

	async runSweep() {
		if (!this.shouldUseRedis()) return
		const results = await this.clusterState.sweep()
		await this.handleSweepResults(results)
	}

	async handleSweepResults(results) {
		const { presentationsCleared = [], recordingsCleared = [], syncersCleared = [] } = results || {}

		for (const entry of presentationsCleared) {
			this.io.to(entry.roomId).emit('user-stopped-presenting', {
				userId: entry.presenterId,
				username: entry.presenterName,
			})
		}

		for (const entry of recordingsCleared) {
			this.io.to(entry.roomId).emit('user-stopped-recording', {
				userId: entry.userId,
				username: entry.username || 'Unknown User',
			})
		}

		for (const entry of syncersCleared) {
			await this.findNewSyncer(entry.roomId)
		}
	}

	setupServerSideEvents() {
		if (!this.io || !this.io.on) {
			return
		}

		this.io.on('recording-stop-request', async (payload) => {
			const { roomID, userId, requesterSocketId } = payload || {}
			if (!roomID || !userId) {
				return
			}

			const recordingEntry = await this.getRecordingEntry(roomID, userId)
			if (!recordingEntry || recordingEntry.nodeId !== this.nodeId) {
				return
			}

			const recordingKey = this.#getRecordingKey(roomID, userId)
			const recordingService = this.recordingServices.get(recordingKey)
			const username = recordingEntry.username || 'Unknown User'

			if (!recordingService) {
				await this.removeRecordingEntry(roomID, userId)
				if (requesterSocketId) {
					this.io.to(requesterSocketId).emit('recording-error', 'No active recording found')
				}
				return
			}

			await this.finalizeRecordingStop({
				roomID,
				userId,
				username,
				recordingKey,
				recordingService,
				requesterSocketId,
			})
		})
	}

	async finalizeRecordingStop({
		roomID,
		userId,
		username,
		recordingKey,
		recordingService,
		initiatorSocket = null,
		requesterSocketId = null,
	}) {
		const { recorder, uploadToken } = recordingService
		try {
			const result = await recorder.stopRecording(roomID, userId)
			if (!result) {
				throw new Error('Failed to stop recording')
			}

			await recorder.cleanup(roomID, userId)

			const payload = {
				filePath: result.localPath,
				recordingData: result.recordingData,
				uploadToken,
				fileId: roomID,
			}

			if (initiatorSocket) {
				initiatorSocket.emit('recording-stopped', payload)
				initiatorSocket.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			} else if (requesterSocketId) {
				this.io.to(requesterSocketId).emit('recording-stopped', payload)
				this.io.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			} else {
				this.io.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			}
		} catch (error) {
			console.error(`[${roomID}_${userId}] Stop recording failed:`, error)
			if (initiatorSocket) {
				initiatorSocket.emit('recording-error', error.message)
			} else if (requesterSocketId) {
				this.io.to(requesterSocketId).emit('recording-error', error.message)
			}
		} finally {
			if (recordingKey && this.recordingServices.has(recordingKey)) {
				this.recordingServices.delete(recordingKey)
			}
			await this.removeRecordingEntry(roomID, userId)
		}
	}

	async forwardRecordingStop(roomID, userId, requesterSocketId) {
		if (!this.shouldUseRedis() || !this.io?.serverSideEmit) {
			return false
		}
		this.io.serverSideEmit('recording-stop-request', {
			roomID,
			userId,
			requesterSocketId,
		})
		return true
	}

	async cleanupLocalSessionData() {
		this.shuttingDown = true
		const socketIds = this.io?.sockets ? Array.from(this.io.sockets.sockets.keys()) : []
		const cleanupTasks = []
		const syncerRoomsToClear = new Set()

		for (const socketId of socketIds) {
			const socketData = await this.socketDataStorage.get(socketId)
			const socket = this.io.sockets.sockets.get(socketId)
			const rooms = socket ? Array.from(socket.rooms).filter((room) => room !== socketId) : []

			for (const roomId of rooms) {
				const currentSyncer = await this.getRoomSyncer(roomId)
				const currentSyncerUserId = currentSyncer?.userId

				if (!currentSyncerUserId || !socketData?.user?.id || socketData.user.id !== currentSyncerUserId) {
					continue
				}

				const roomSockets = await this.getUserSocketsInRoom(roomId)
				const otherActiveSocket = roomSockets
					.filter(Boolean)
					.some((entry) => entry.userId === currentSyncerUserId && entry.socketId !== socketId)

				if (!otherActiveSocket) {
					syncerRoomsToClear.add(roomId)
				}
			}
		}

		for (const socketId of socketIds) {
			cleanupTasks.push(this.socketDataStorage.delete(socketId))
			cleanupTasks.push(this.socketDataStorage.delete(`${socketId}:connected_at`))
			cleanupTasks.push(this.socketDataStorage.delete(`${socketId}:following`))
		}

		await Promise.all(cleanupTasks)

		const cleared = await this.clusterState.clearNodeState(this.nodeId)
		await this.handleSweepResults(cleared)

		for (const roomId of syncerRoomsToClear) {
			await this.findNewSyncer(roomId)
		}
		this.stopStateSweeper()
		await this.nodePresence.stop()
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
			'check-recording-availability': this.checkRecordingAvailabilityHandler,
			'start-recording': this.startRecordingHandler,
			'stop-recording': this.stopRecordingHandler,
			'presentation-start': this.presentationStartHandler,
			'presentation-stop': this.presentationStopHandler,
			'timer-start': this.timerStartHandler,
			'timer-pause': this.timerPauseHandler,
			'timer-resume': this.timerResumeHandler,
			'timer-reset': this.timerResetHandler,
			'timer-extend': this.timerExtendHandler,
			'timer-state-request': this.timerStateRequestHandler,
			'request-presenter-viewport': this.requestPresenterViewportHandler,
			'follow-user': this.followUserHandler,
			'request-viewport': this.requestViewportHandler,
			'viewport-change': this.viewportChangeHandler,
			[SOCKET_MSG.VOTING_START]: this.votingStartHandler,
			[SOCKET_MSG.VOTING_VOTE]: this.votingVoteHandler,
			[SOCKET_MSG.VOTING_END]: this.votingEndHandler,
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
		const currentSyncer = await this.getRoomSyncer(roomID)
		let currentSyncerUserId = currentSyncer?.userId
		if (currentSyncer?.nodeId && !(await this.isNodeAlive(currentSyncer.nodeId))) {
			await this.clearRoomSyncer(roomID)
			currentSyncerUserId = null
		}
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
			await this.setRoomSyncer(roomID, userId)

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
		const presentationSession = await this.getPresentationSession(roomID)
		if (presentationSession) {
			console.log(`[${roomID}] Notifying new user ${userName} about active presentation by ${presentationSession.presenterName}`)
			socket.emit('user-started-presenting', {
				userId: presentationSession.presenterId,
				username: presentationSession.presenterName,
			})
		}

		// Rehydrate timer and voting state from distributed storage
		await this.loadTimerState(roomID)
		this.emitTimerState(roomID, socket)

		await this.loadVotings(roomID)
		const existingVotings = this.votingManager.getAllVotings(roomID)
		if (existingVotings && existingVotings.length > 0) {
			console.log(`[${roomID}] Sending ${existingVotings.length} existing voting(s) to new user ${userName}`)
			socket.emit(SOCKET_MSG.VOTINGS_INIT, existingVotings)
		}

		// Rehydrate active recordings so late joiners on any node are aware
		const recordingState = await this.getRecordingState(roomID)
		Object.values(recordingState).forEach((entry) => {
			if (!entry) {
				return
			}
			socket.emit('user-started-recording', {
				userId: entry.userId,
				username: entry.username,
			})
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

	// VOTING HANDLERS
	/**
	 * Handles starting a voting
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {object} votingData - Voting data containing question and options
	 */
	async votingStartHandler(socket, roomID, votingData) {
		try {
			const isReadOnly = await this.isSocketReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			const { question, type, options } = votingData
			const socketData = await this.socketDataStorage.get(socket.id)
			const voting = this.votingManager.createVoting(roomID, question, socketData.user.id, type, options)

			Utils.logOperation(roomID, `Started voting: ${JSON.stringify(votingData)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_STARTED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error starting voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-start' })
		}
	}

	/**
	 * Handles voting
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {string} votingId - Unique identifier of the voting
	 * @param {string} optionId - Unique identifier of the option
	 */
	async votingVoteHandler(socket, roomID, votingId, optionId) {
		try {
			const isReadOnly = await this.isSocketReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			const socketData = await this.socketDataStorage.get(socket.id)
			const voting = this.votingManager.addVote(roomID, votingId, optionId, socketData.user.id)

			Utils.logOperation(roomID, `${socketData.user.id} voted: ${JSON.stringify(voting)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_VOTED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-vote' })
		}
	}

	/**
	 * Handles ending a voting
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {string} votingId - Unique identifier of the voting to end
	 */
	async votingEndHandler(socket, roomID, votingId) {
		try {
			const isReadOnly = await this.isSocketReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			const socketData = await this.socketDataStorage.get(socket.id)

			const voting = this.votingManager.endVoting(roomID, votingId, socketData.user.id)

			Utils.logOperation(roomID, `Voting closed: ${JSON.stringify(voting)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_ENDED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error ending voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-end' })
		}
	}

	// DISCONNECTION HANDLERS
	/**
	 * Handles socket disconnection
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 */
	async disconnectHandler(socket) {
		try {
			await Promise.all([
				this.socketDataStorage.delete(socket.id),
				this.socketDataStorage.delete(`${socket.id}:connected_at`),
				this.socketDataStorage.delete(`${socket.id}:following`),
			])

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
		if (this.shuttingDown) {
			return
		}
		for (const roomID of rooms) {
			if (roomID === socket.id) continue

			const socketData = await this.socketDataStorage.get(socket.id)
			const userId = socketData?.user?.id
			const userName = socketData?.user?.name || 'Unknown'

			console.log(`[${roomID}] User ${userName} disconnecting`)

			// Check if user was syncer and if they have other active connections in the room
			const currentSyncer = await this.getRoomSyncer(roomID)
			const currentSyncerUserId = currentSyncer?.userId
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
			const presentationSession = await this.getPresentationSession(roomID)
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
					const roomSockets = await this.getUserSocketsInRoom(roomID)
					const presenterStillConnected = roomSockets
						.filter(Boolean)
						.some((s) => s.userId === presentationSession.presenterId && s.socketId !== socket.id)

					if (presenterStillConnected) {
						console.log(`[${roomID}] Presenter still connected on another socket, skipping presentation end`)
						continue
					}

					console.log(`[${roomID}] Presenter ${userName} disconnected, ending presentation`)
					await this.clearPresentationSession(roomID)

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

	async getSocketUserInfo(socketId) {
		const socketData = await this.socketDataStorage.get(socketId)
		const userId = socketData?.user?.id || 'unknown'
		const userName = socketData?.user?.displayName || socketData?.user?.name || 'Unknown'

		return { userId, userName }
	}

	clearTimerTimeout(roomID) {
		const timerState = this.timers.get(roomID)
		if (timerState?.timeoutId) {
			clearTimeout(timerState.timeoutId)
			timerState.timeoutId = null
		}
	}

	getTimerPayload(roomID) {
		const timerState = this.timers.get(roomID)
		const now = Date.now()
		const updatedAt = timerState?.updatedAt ?? now

		if (!timerState) {
			return {
				status: 'idle',
				remainingMs: 0,
				durationMs: null,
				endsAt: null,
				startedBy: null,
				startedAt: null,
				pausedBy: null,
				updatedAt,
			}
		}

		const remainingMs = timerState.status === 'running' && timerState.endsAt
			? Math.max(timerState.endsAt - now, 0)
			: Math.max(timerState.remainingMs || 0, 0)

		return {
			status: timerState.status,
			remainingMs,
			durationMs: timerState.durationMs ?? null,
			endsAt: timerState.status === 'running' ? timerState.endsAt : null,
			startedBy: timerState.startedBy || null,
			startedAt: timerState.startedAt || null,
			pausedBy: timerState.pausedBy || null,
			updatedAt,
		}
	}

	emitTimerState(roomID, targetSocket = null) {
		const payload = this.getTimerPayload(roomID)

		if (targetSocket) {
			targetSocket.emit('timer-state', payload)
		} else {
			this.io.to(roomID).emit('timer-state', payload)
		}
	}

	async loadTimerState(roomID) {
		const stored = await this.distributedState.getValue(this.#getTimerKey(roomID))
		if (!stored) {
			return
		}

		this.clearTimerTimeout(roomID)

		const now = Date.now()
		let timeoutId = null
		let remainingMs = stored.remainingMs || 0
		let endsAt = stored.endsAt || null

		if (stored.status === 'running' && stored.endsAt) {
			const remaining = Math.max(stored.endsAt - now, 0)
			if (remaining === 0) {
				this.handleTimerFinished(roomID)
				return
			}
			timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remaining)
			remainingMs = remaining
			endsAt = now + remaining
		}

		this.timers.set(roomID, {
			...stored,
			remainingMs,
			endsAt,
			timeoutId,
		})
	}

	async persistTimerState(roomID) {
		const timerState = this.timers.get(roomID)
		if (!timerState) {
			await this.distributedState.deleteValue(this.#getTimerKey(roomID))
			return
		}
		const { timeoutId, ...serializable } = timerState
		await this.distributedState.setValue(this.#getTimerKey(roomID), serializable, {
			ttlMs: Config.SESSION_TTL,
		})
	}

	async clearTimerState(roomID) {
		this.clearTimerTimeout(roomID)
		this.timers.delete(roomID)
		await this.distributedState.deleteValue(this.#getTimerKey(roomID))
	}

	handleTimerFinished(roomID) {
		const timerState = this.timers.get(roomID)
		if (!timerState) {
			return
		}

		this.clearTimerTimeout(roomID)

		this.timers.set(roomID, {
			...timerState,
			status: 'finished',
			remainingMs: 0,
			endsAt: null,
			timeoutId: null,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer finished`)
		this.persistTimerState(roomID).catch(() => {})
		this.emitTimerState(roomID)
	}

	async timerStartHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		const rawDuration = Number(data?.durationMs)

		if (!roomID || !Number.isFinite(rawDuration)) {
			socket.emit('timer-error', 'Invalid timer start payload')
			return
		}

		if (await this.isSocketReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const durationMs = Math.max(Math.floor(rawDuration), 1000)
		const now = Date.now()
		const userInfo = await this.getSocketUserInfo(socket.id)

		this.clearTimerTimeout(roomID)

		const timeoutId = setTimeout(() => this.handleTimerFinished(roomID), durationMs)

		this.timers.set(roomID, {
			status: 'running',
			durationMs,
			remainingMs: durationMs,
			endsAt: now + durationMs,
			startedAt: now,
			startedBy: userInfo,
			pausedBy: null,
			timeoutId,
			updatedAt: now,
		})

		console.log(`[${roomID}] Timer started for ${durationMs}ms by ${userInfo.userName}`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async timerPauseHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer pause payload')
			return
		}

		if (await this.isSocketReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || timerState.status !== 'running') {
			socket.emit('timer-error', 'No active timer to pause')
			return
		}

		const remainingMs = timerState.endsAt
			? Math.max(timerState.endsAt - Date.now(), 0)
			: timerState.remainingMs || 0

		this.clearTimerTimeout(roomID)

		this.timers.set(roomID, {
			...timerState,
			status: 'paused',
			remainingMs,
			endsAt: null,
			pausedBy: await this.getSocketUserInfo(socket.id),
			timeoutId: null,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer paused with ${remainingMs}ms remaining`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async timerResumeHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer resume payload')
			return
		}

		if (await this.isSocketReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || timerState.status !== 'paused') {
			socket.emit('timer-error', 'No paused timer to resume')
			return
		}

		const remainingMs = Math.max(timerState.remainingMs || 0, 0)
		if (remainingMs === 0) {
			this.handleTimerFinished(roomID)
			return
		}

		const endsAt = Date.now() + remainingMs
		const timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remainingMs)

		this.timers.set(roomID, {
			...timerState,
			status: 'running',
			endsAt,
			pausedBy: null,
			timeoutId,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer resumed with ${remainingMs}ms remaining`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async timerExtendHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		const additionalMs = Number(data?.additionalMs)

		if (!roomID || !Number.isFinite(additionalMs)) {
			socket.emit('timer-error', 'Invalid timer extend payload')
			return
		}

		if (await this.isSocketReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || (timerState.status !== 'running' && timerState.status !== 'paused')) {
			socket.emit('timer-error', 'No timer to extend')
			return
		}

		const extraTime = Math.max(Math.floor(additionalMs), 1000)
		const now = Date.now()

		let endsAt = timerState.endsAt
		let remainingMs = timerState.remainingMs || 0
		let timeoutId = timerState.timeoutId || null

		if (timerState.status === 'running') {
			const currentRemaining = endsAt
				? Math.max(endsAt - now, 0)
				: remainingMs

			endsAt = now + currentRemaining + extraTime
			remainingMs = Math.max(endsAt - now, 0)

			this.clearTimerTimeout(roomID)
			timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remainingMs)
		} else {
			remainingMs = (timerState.remainingMs || 0) + extraTime
			endsAt = null
			this.clearTimerTimeout(roomID)
			timeoutId = null
		}

		this.timers.set(roomID, {
			...timerState,
			durationMs: (timerState.durationMs || 0) + extraTime,
			remainingMs,
			endsAt,
			timeoutId,
			updatedAt: now,
		})

		console.log(`[${roomID}] Timer extended by ${extraTime}ms`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async timerResetHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer reset payload')
			return
		}

		if (await this.isSocketReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		await this.clearTimerState(roomID)

		console.log(`[${roomID}] Timer reset`)
		this.emitTimerState(roomID)
	}

	async timerStateRequestHandler(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer state request')
			return
		}

		if (!socket.rooms.has(roomID)) {
			return
		}

		await this.loadTimerState(roomID)
		this.emitTimerState(roomID, socket)
	}

	async loadVotings(roomID) {
		const stored = await this.distributedState.getValue(this.#getVotingKey(roomID))
		if (stored && Array.isArray(stored)) {
			this.votingManager.setRoomVotings(roomID, stored)
		}
	}

	async persistVotings(roomID) {
		const votings = this.votingManager.getAllVotings(roomID)
		if (votings.length === 0) {
			await this.distributedState.deleteValue(this.#getVotingKey(roomID))
			return
		}
		await this.distributedState.setValue(this.#getVotingKey(roomID), votings, {
			ttlMs: Config.SESSION_TTL,
		})
	}

	async clearVotingState(roomID) {
		this.votingManager.cleanupRoom(roomID)
		await this.distributedState.deleteValue(this.#getVotingKey(roomID))
	}

	async findNewSyncer(roomID) {
		const userSockets = await this.getUserSocketsInRoom(roomID)

		console.log(`[${roomID}] Finding new syncer. Users in room: ${userSockets.length}`)

		if (userSockets.length === 0) {
			console.log(`[${roomID}] No users left in room, no syncer needed`)
			await this.clearRoomSyncer(roomID)
			await this.clearTimerState(roomID)
			await this.clearVotingState(roomID)
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
					await this.setRoomSyncer(roomID, userId)

					// Update all sockets for this user
					for (const s of sockets) {
						const socketData = await this.socketDataStorage.get(s.socketId)
						if (socketData) {
							await this.socketDataStorage.set(s.socketId, {
								...socketData,
								isSyncer: true,
								syncerFor: roomID,
							})

							this.io.to(s.socketId).emit('sync-designate', { isSyncer: true })
						}
					}

					console.log(`[${roomID}] Promoted new syncer: ${sockets[0].userName}`)
					return
				}
			}
		}

		console.log(`[${roomID}] No eligible users found for syncer role`)
		await this.clearRoomSyncer(roomID)
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
	 * Handles recording availability check requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 */
	async checkRecordingAvailabilityHandler(socket) {
		try {
			const support = await checkPuppeteerAvailability({ force: false })
			socket.emit('recording-availability', {
				available: support.available,
				reason: support.reason || null,
			})
		} catch (error) {
			console.error('[Recording] Availability check failed:', error)
			socket.emit('recording-availability', {
				available: false,
				reason: 'Failed to check recording availability. Please try again later.',
			})
		}
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

			const existingRecording = await this.getRecordingEntry(roomID, socketData.user.id)
			if (existingRecording) {
				throw new Error('Recording already in progress')
			}

			// Check if recording already in progress
			const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
			if (this.recordingServices.has(recordingKey)) {
				throw new Error('Recording already in progress')
			}

			// Initialize recording service
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
			await this.setRecordingEntry(roomID, socketData.user.id, {
				userId: socketData.user.id,
				username: socketData.user.displayName || socketData.user.name || 'Unknown User',
				uploadToken,
				status: 'recording',
				nodeId: this.nodeId,
				startedAt: Date.now(),
			})

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
			const recordingEntry = await this.getRecordingEntry(roomID, socketData.user.id)

			if (!recordingService && recordingEntry?.nodeId && recordingEntry.nodeId !== this.nodeId) {
				console.log(`[${sessionKey}] Forwarding stop request to node ${recordingEntry.nodeId}`)
				const forwarded = await this.forwardRecordingStop(roomID, socketData.user.id, socket.id)
				if (!forwarded) {
					throw new Error('No active recording found')
				}
				setTimeout(async () => {
					try {
						const latestEntry = await this.getRecordingEntry(roomID, socketData.user.id)
						if (latestEntry && latestEntry.nodeId === recordingEntry.nodeId) {
							await this.removeRecordingEntry(roomID, socketData.user.id)
							socket.emit('recording-error', 'Recording host unavailable, please try again')
						}
					} catch (err) {
						console.error(`[${sessionKey}] Failed to clear stale recording entry:`, err)
					}
				}, 3000)
				return
			}

			if (!recordingService) {
				console.log(`[${sessionKey}] Available recording keys:`, Array.from(this.recordingServices.keys()))
				await this.removeRecordingEntry(roomID, socketData.user.id)
				throw new Error('No active recording found')
			}

			const username = recordingEntry?.username
				|| socketData.user.displayName
				|| socketData.user.name
				|| 'Unknown User'

			console.log(`[${sessionKey}] Stopping recording locally on node ${this.nodeId}`)
			await this.finalizeRecordingStop({
				roomID,
				userId: socketData.user.id,
				username,
				recordingKey,
				recordingService,
				initiatorSocket: socket,
				requesterSocketId: socket.id,
			})
			console.log(`[${sessionKey}] Stop recording completed successfully`)

		} catch (error) {
			console.error(`[${sessionKey}] Stop recording failed:`, error)
			console.error(`[${sessionKey}] Error stack:`, error.stack)
			socket.emit('recording-error', error.message)
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
			const existingSession = await this.getPresentationSession(roomID)
			if (existingSession) {
				// If the same user is trying to start again, allow it (might be a reconnection)
				if (existingSession.presenterId === authoritativeUserId) {
					console.log(`[${sessionKey}] User ${socketData.user.displayName} restarting their presentation`)
					// Update the session timestamp
					existingSession.startTime = Date.now()
					await this.setPresentationSession(roomID, existingSession)

					// Notify the presenter
					socket.emit('presentation-started')
					return // Exit early, no need to create new session
				} else {
					throw new Error(`Presentation already in progress by ${existingSession.presenterName}`)
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

			await this.setPresentationSession(roomID, {
				...presentationSession,
				nodeId: this.nodeId,
			})
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
			const presentationSession = await this.getPresentationSession(roomID)
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
			await this.clearPresentationSession(roomID)
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
			const presentationSession = await this.getPresentationSession(roomID)
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
