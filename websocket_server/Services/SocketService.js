/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import GeneralUtility from '../Utilities/GeneralUtility.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import Config from '../Utilities/ConfigUtility.js'
import SessionStore from '../Stores/SessionStore.js'
import RoomStateStore from '../Stores/RoomStateStore.js'
import ClusterService from './ClusterService.js'
import RoomLifecycleService from './RoomLifecycleService.js'
import PresentationService from './PresentationService.js'
import RecordingControlService from './RecordingControlService.js'
import ViewportService from './ViewportService.js'
import TimerService from './TimerService.js'
import VotingService from './VotingService.js'
import { SOCKET_MSG } from '../../src/shared/constants.js'

export default class SocketService {

	static HEARTBEAT_KEY_PREFIX = 'node:'

	static HEARTBEAT_TTL_MS = 15000

	#getRecordingKey(roomId, userId) {
		return `${roomId}_${userId}`
	}

	// Debug method to check recording services state
	debugRecordingServices() {
		console.log('Active recording services:', Array.from(this.recordingServices.keys()))
		return this.recordingServices
	}

	// Debug method to check presentation sessions state
	async debugPresentationSessions() {
		const keys = await this.roomStateStore.listValueKeys('room:*:presentation')
		const sessions = []
		for (const key of keys) {
			const value = await this.roomStateStore.getValue(key)
			sessions.push([key, value])
		}
		console.log('Active presentation sessions:', sessions)
		return sessions
	}

	constructor(server, socketDataStorage, cachedTokenStorage, redisClient) {
		this.socketDataStorage = socketDataStorage
		this.cachedTokenStorage = cachedTokenStorage
		this.redisClient = redisClient
		this.sessionStore = new SessionStore(this.socketDataStorage)
		this.recordingServices = new Map()
		this.nodeId = process.env.WEBSOCKET_NODE_ID || process.env.HOSTNAME || `node-${crypto.randomUUID()}`
		this.shuttingDown = false
		this.roomStateStore = new RoomStateStore({
			redisClient,
			prefix: this.socketDataStorage?.strategy?.prefix || 'socket_',
			defaultTtlMs: Config.SESSION_TTL,
		})
		this.clusterService = new ClusterService({
			redisClient,
			roomStateStore: this.roomStateStore,
			nodeId: this.nodeId,
			sessionTtl: Config.SESSION_TTL,
			heartbeatTtlMs: SocketService.HEARTBEAT_TTL_MS,
			heartbeatKeyPrefix: SocketService.HEARTBEAT_KEY_PREFIX,
		})
		this.io = this.createSocketServer(server)
		this.presentationController = new PresentationService({
			cluster: this.clusterService,
			sessionStore: this.sessionStore,
			io: this.io,
			nodeId: this.nodeId,
		})
		this.recordingController = new RecordingControlService({
			cluster: this.clusterService,
			sessionStore: this.sessionStore,
			io: this.io,
			nodeId: this.nodeId,
			recordingServices: this.recordingServices,
		})
		this.timerService = new TimerService({
			io: this.io,
			sessionStore: this.sessionStore,
			roomStateStore: this.roomStateStore,
		})
		this.votingService = new VotingService({
			io: this.io,
			sessionStore: this.sessionStore,
			roomStateStore: this.roomStateStore,
		})
		this.viewportController = new ViewportService({
			io: this.io,
			sessionStore: this.sessionStore,
		})
		this.roomLifecycleController = new RoomLifecycleService({
			io: this.io,
			sessionStore: this.sessionStore,
			cluster: {
				getRoomSyncer: this.getRoomSyncer.bind(this),
				setRoomSyncer: this.setRoomSyncer.bind(this),
				trySetRoomSyncer: this.trySetRoomSyncer.bind(this),
				clearRoomSyncer: this.clearRoomSyncer.bind(this),
				isNodeAlive: this.isNodeAlive.bind(this),
			},
			presentationState: {
				getPresentationSession: this.getPresentationSession.bind(this),
				clearPresentationSession: this.clearPresentationSession.bind(this),
			},
			recordingState: {
				getRecordingState: this.getRecordingState.bind(this),
			},
			timerService: this.timerService,
			votingService: this.votingService,
		})
		this.clusterService.setSweepHandler(this.handleSweepResults.bind(this))
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
		return this.clusterService.getPresentation(roomID)
	}

	async setPresentationSession(roomID, session) {
		return this.clusterService.setPresentation(roomID, session)
	}

	async clearPresentationSession(roomID) {
		await this.clusterService.clearPresentation(roomID)
	}

	async getRecordingState(roomID) {
		return this.clusterService.getRecordingState(roomID)
	}

	async setRecordingEntry(roomID, userId, entry) {
		return this.clusterService.setRecordingEntry(roomID, userId, entry)
	}

	async getRecordingEntry(roomID, userId) {
		const state = await this.getRecordingState(roomID)
		return state[userId]
	}

	async removeRecordingEntry(roomID, userId) {
		return this.clusterService.removeRecordingEntry(roomID, userId)
	}

	async getRoomSyncer(roomID) {
		return this.clusterService.getSyncer(roomID)
	}

	async setRoomSyncer(roomID, userId) {
		await this.clusterService.setSyncer(roomID, userId)
	}

	async trySetRoomSyncer(roomID, userId) {
		return this.clusterService.trySetSyncer(roomID, userId)
	}

	async clearRoomSyncer(roomID) {
		await this.clusterService.clearSyncer(roomID)
	}

	async init() {
		await this.setupAdapter()
		await this.clusterService.start()
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
		this.clusterService.startStateSweeper()
	}

	stopStateSweeper() {
		this.clusterService.stopStateSweeper()
	}

	async isNodeAlive(nodeId) {
		return this.clusterService.isNodeAlive(nodeId)
	}

	async runSweep() {
		return this.clusterService.runSweep()
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
			await this.roomLifecycleController.findNewSyncer(entry.roomId)
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
		return this.recordingController.finalizeRecordingStop({
			roomID,
			userId,
			username,
			recordingKey,
			recordingService,
			initiatorSocket,
			requesterSocketId,
		})
	}

	async forwardRecordingStop(roomID, userId, requesterSocketId) {
		return this.recordingController.forwardRecordingStop(roomID, userId, requesterSocketId)
	}

	async cleanupLocalSessionData() {
		this.shuttingDown = true
		const socketIds = this.io?.sockets ? Array.from(this.io.sockets.sockets.keys()) : []
		const cleanupTasks = []
		const syncerRoomsToClear = new Set()

		for (const socketId of socketIds) {
			const socketData = await this.sessionStore.getSocketData(socketId)
			const socket = this.io.sockets.sockets.get(socketId)
			const rooms = socket ? Array.from(socket.rooms).filter((room) => room !== socketId) : []

			for (const roomId of rooms) {
				const currentSyncer = await this.getRoomSyncer(roomId)
				const currentSyncerUserId = currentSyncer?.userId

				if (!currentSyncerUserId || !socketData?.user?.id || socketData.user.id !== currentSyncerUserId) {
					continue
				}

				const roomSockets = await this.roomLifecycleController.getUserSocketsInRoom(roomId)
				const otherActiveSocket = roomSockets
					.filter(Boolean)
					.some((entry) => entry.userId === currentSyncerUserId && entry.socketId !== socketId)

				if (!otherActiveSocket) {
					syncerRoomsToClear.add(roomId)
				}
			}
		}

		for (const socketId of socketIds) {
			cleanupTasks.push(this.sessionStore.clearSocketMeta(socketId))
		}

		await Promise.all(cleanupTasks)

		const cleared = await this.clusterService.clearNodeState(this.nodeId)
		await this.handleSweepResults(cleared)

		for (const roomId of syncerRoomsToClear) {
			await this.roomLifecycleController.findNewSyncer(roomId)
		}
		await this.clusterService.stop()
	}

	async socketAuthenticateHandler(socket, next) {
		const { token, secret } = socket.handshake.auth

		try {
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			await this.sessionStore.setSocketData(socket.id, decodedData)

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
				const now = Math.floor(Date.now() / 1000)
				const ttlMs = decoded.exp ? (decoded.exp - now) * 1000 : Config.CACHED_TOKEN_TTL
				if (ttlMs > 0) {
					await this.cachedTokenStorage.set(token, decoded, { ttl: ttlMs })
				}
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
		this.sessionStore.setConnectedAt(socket.id, Date.now())

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
			'request-presenter-viewport': this.requestPresenterViewportHandler,
			'request-viewport': this.requestViewportHandler,
			'viewport-change': this.viewportChangeHandler,
			'timer-start': this.timerStartHandler,
			'timer-pause': this.timerPauseHandler,
			'timer-resume': this.timerResumeHandler,
			'timer-reset': this.timerResetHandler,
			'timer-extend': this.timerExtendHandler,
			'timer-state-request': this.timerStateRequestHandler,
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
		return this.roomLifecycleController.joinRoom(socket, roomID)
	}

	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		return this.viewportController.serverBroadcast(socket, roomID, encryptedData, iv)
	}

	async serverVolatileBroadcastHandler(socket, roomID, encryptedData) {
		return this.viewportController.serverVolatileBroadcast(socket, roomID, encryptedData)
	}

	async imageGetHandler(socket, roomId, id) {
		return this.viewportController.imageGet(socket, roomId, id)
	}

	async disconnectHandler(socket) {
		try {
			await this.sessionStore.clearSocketMeta(socket.id)

			socket.removeAllListeners()

			if (socket.connected) {
				socket.disconnect(true)
			}

			GeneralUtility.logOperation('SOCKET', `Cleaned up socket: ${socket.id}`)
		} catch (error) {
			GeneralUtility.logError(
				'SOCKET',
				`Failed to cleanup socket: ${socket.id}`,
				error,
			)
		}
	}

	async disconnectingHandler(socket, rooms) {
		return this.roomLifecycleController.onDisconnecting(socket, rooms, { shuttingDown: this.shuttingDown })
	}

	async findNewSyncer(roomID) {
		return this.roomLifecycleController.findNewSyncer(roomID)
	}

	async safeSocketHandler(socket, handler) {
		try {
			const socketData = await this.sessionStore.getSocketData(socket.id)
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
		return this.sessionStore.isReadOnly(socketId)
	}

	/**
	 * Gets user sockets and IDs for a room (deduplicated by user ID)
	 * @param {string} roomID - Room identifier
	 * @return {Promise<Array<{socketId: string, user: object, userId: string, socketIds: string[]}>>}
	 */
	async getUserSocketsAndIds(roomID) {
		return this.roomLifecycleController.getUserSocketsAndIds(roomID)
	}

	/**
	 * Gets detailed socket information for users in a room
	 * @param {string} roomID - Room identifier
	 * @return {Promise<Array<{socketId: string, userId: string, userName: string}>>}
	 */
	async getUserSocketsInRoom(roomID) {
		return this.roomLifecycleController.getUserSocketsInRoom(roomID)
	}

	/**
	 * Handles recording availability check requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 */
	async checkRecordingAvailabilityHandler(socket) {
		return this.recordingController.checkAvailability(socket)
	}

	/**
	 * Handles recording start requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Recording data containing fileId, recordingUrl, uploadToken
	 */
	async startRecordingHandler(socket, data) {
		return this.recordingController.startRecording(socket, data)
	}

	/**
	 * Handles recording stop requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 */
	async stopRecordingHandler(socket, roomID) {
		return this.recordingController.stopRecording(socket, roomID)
	}

	/**
	 * Handles presentation start requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Presentation data containing fileId, userId
	 */
	async presentationStartHandler(socket, data) {
		return this.presentationController.start(socket, data)
	}

	/**
	 * Handles presentation stop requests
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Presentation data containing fileId
	 */
	async presentationStopHandler(socket, data) {
		return this.presentationController.stop(socket, data)
	}

	/**
	 * Handles request for presenter's viewport
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Request data containing fileId
	 */
	async requestPresenterViewportHandler(socket, data) {
		return this.presentationController.requestPresenterViewport(socket, data)
	}

	/**
	 * Handles viewport request events
	 * @param {import('socket.io').Socket} socket - Socket.IO socket instance
	 * @param {object} data - Request data containing fileId and userId
	 */
	async requestViewportHandler(socket, data) {
		return this.viewportController.requestViewport(socket, data)
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

	async timerStartHandler(socket, data) {
		return this.timerService.start(socket, data)
	}

	async timerPauseHandler(socket, data) {
		return this.timerService.pause(socket, data)
	}

	async timerResumeHandler(socket, data) {
		return this.timerService.resume(socket, data)
	}

	async timerResetHandler(socket, data) {
		return this.timerService.reset(socket, data)
	}

	async timerExtendHandler(socket, data) {
		return this.timerService.extend(socket, data)
	}

	async timerStateRequestHandler(socket, data) {
		return this.timerService.sendState(socket, data)
	}

	async votingStartHandler(socket, roomID, votingData) {
		return this.votingService.start(socket, roomID, votingData)
	}

	async votingVoteHandler(socket, roomID, votingId, optionId) {
		return this.votingService.vote(socket, roomID, votingId, optionId)
	}

	async votingEndHandler(socket, roomID, votingId) {
		return this.votingService.end(socket, roomID, votingId)
	}

}
