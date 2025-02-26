/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO, Socket } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import Utils from './Utils.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import RoomDataManager from './RoomDataManager.js'
import StorageManager from './StorageManager.js'
import { Server } from 'http'
import { Server as HttpsServer } from 'https'
import Config from './Config.js'
import StorageStrategy from './StorageStrategy.js'

/**
 * Manages WebSocket connections and room interactions
 */
export default class SocketManager {

	/**
	 * Creates a new SocketManager instance
	 * @param {Server|HttpsServer} server - HTTP/HTTPS server instance
	 * @param {RoomDataManager} roomDataManager - Manager for room data
	 * @param {StorageManager} storageManager - Manager for room data storage
	 * @param {StorageStrategy} socketDataStorage - Manager for socket data storage
	 * @param {StorageStrategy} cachedTokenStorage - Manager for cached token storage
	 * @param {object} redisClient - Shared Redis client
	 */
	constructor(server, roomDataManager, storageManager, socketDataStorage, cachedTokenStorage, redisClient) {
		this.roomDataManager = roomDataManager
		this.storageManager = storageManager
		this.socketDataStorage = socketDataStorage
		this.cachedTokenStorage = cachedTokenStorage
		this.redisClient = redisClient
		this.io = this.createSocketServer(server)
		this.init()
	}

	// SERVER SETUP METHODS
	/**
	 * Creates and configures the Socket.IO server
	 * @param {Server|HttpsServer} server - HTTP/HTTPS server instance
	 * @return {SocketIO.Server} Configured Socket.IO server instance
	 */
	createSocketServer(server) {
		return new SocketIO(server, {
			transports: ['websocket', 'polling'],
			maxHttpBufferSize: Config.MAX_UPLOAD_FILE_SIZE + 1e6,
			cors: {
				origin: Config.NEXTCLOUD_WEBSOCKET_URL,
				methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				credentials: true,
			},
		})
	}

	/**
	 * Initializes the socket server and sets up necessary configurations
	 * @return {Promise<void>}
	 */
	async init() {
		await this.setupAdapter()
		this.setupEventHandlers()
	}

	/**
	 * Sets up the appropriate adapter (Redis or in-memory)
	 * @return {Promise<void>}
	 */
	async setupAdapter() {
		if (this.shouldUseRedis()) {
			await this.setupRedisStreamsAdapter()
		} else {
			console.log('Using default in-memory adapter')
		}
	}

	/**
	 * Configures Redis Streams adapter for Socket.IO
	 * @return {Promise<void>}
	 */
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

	/**
	 * Determines if Redis should be used as the adapter
	 * @return {boolean}
	 */
	shouldUseRedis() {
		return !!this.redisClient
	}

	// AUTHENTICATION METHODS
	/**
	 * Handles socket authentication
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {Function} next - Next middleware function
	 * @return {Promise<void>}
	 */
	async socketAuthenticateHandler(socket, next) {
		try {
			const { token } = socket.handshake.auth
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			await this.socketDataStorage.set(socket.id, decodedData)

			if (decodedData.isFileReadOnly) {
				socket.emit('read-only')
			}
			next()
		} catch (error) {
			await this.handleAuthError(socket, next)
		}
	}

	/**
	 * Handles authentication errors
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {Function} next - Next middleware function
	 */
	async handleAuthError(socket, next) {
		const { secret } = socket.handshake.auth
		try {
			jwt.verify(secret, Config.JWT_SECRET_KEY, { algorithm: 'HS256' })
			next(new Error('Connection verified'))
		} catch (e) {
			next(new Error('Authentication error'))
		}
	}

	/**
	 * Verifies JWT token
	 * @param {string} token - JWT token to verify
	 * @return {Promise<object>} Decoded token data
	 */
	async verifyToken(token) {
		const cachedToken = await this.cachedTokenStorage.get(token)
		console.log('cachedTokenStorage', this.cachedTokenStorage)
		if (cachedToken) return cachedToken

		return new Promise((resolve, reject) => {
			jwt.verify(
				token,
				Config.JWT_SECRET_KEY,
				async (err, decoded) => {
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
				},
			)
		})
	}

	// EVENT SETUP METHODS
	/**
	 * Sets up all event handlers for the socket server
	 */
	setupEventHandlers() {
		this.io.use(this.socketAuthenticateHandler.bind(this))
		prometheusMetrics(this.io)
		this.io.on('connection', this.handleConnection.bind(this))
	}

	/**
	 * Handles new socket connections
	 * @param {Socket} socket - Socket.IO socket instance
	 */
	handleConnection(socket) {
		socket.emit('init-room')
		this.setupSocketEventListeners(socket)
	}

	/**
	 * Sets up event listeners for a specific socket
	 * @param {Socket} socket - Socket.IO socket instance
	 */
	setupSocketEventListeners(socket) {
		const events = {
			'join-room': this.joinRoomHandler,
			'server-broadcast': this.serverBroadcastHandler,
			'server-volatile-broadcast': this.serverVolatileBroadcastHandler,
			'image-add': this.imageAddHandler,
			'image-remove': this.imageRemoveHandler,
			'image-get': this.imageGetHandler,
			disconnect: this.disconnectHandler,
		}

		// Handle regular events
		Object.entries(events).forEach(([event, handler]) => {
			socket.on(event, (...args) =>
				this.safeSocketHandler(socket, () => handler.apply(this, [socket, ...args])),
			)
		})

		// Handle disconnecting separately to ensure correct room capture
		socket.on('disconnecting', () => {
			const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id)
			this.safeSocketHandler(socket, () => this.disconnectingHandler(socket, rooms))
		})
	}

	// ROOM EVENT HANDLERS
	/**
	 * Handles room join requests
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @return {Promise<void>}
	 */
	async joinRoomHandler(socket, roomID) {
		const socketData = await this.socketDataStorage.get(socket.id)
		console.log(`[${roomID}] ${socketData.user.name} has joined ${roomID}`)
		await socket.join(roomID)

		const userSocketsAndIds = await this.getUserSocketsAndIds(roomID)
		const userIds = userSocketsAndIds.map(u => u.userId)

		const room = await this.roomDataManager.syncRoomData(
			roomID,
			null,
			userIds,
			null,
			socket.handshake.auth.token,
		)

		if (room) {
			socket.emit(
				'joined-data',
				Utils.convertStringToArrayBuffer(JSON.stringify(room.data)),
				[],
			)

			Object.values(room.getFiles()).forEach((file) => {
				socket.emit('image-data', file)
			})

			this.io.to(roomID).emit('room-user-change', userSocketsAndIds)
		} else {
			socket.emit('room-not-found')
		}
	}

	/**
	 * Handles broadcast messages to room
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {ArrayBuffer} encryptedData - Encrypted message data
	 * @param {string} iv - Initialization vector
	 * @return {Promise<void>}
	 */
	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(Utils.convertArrayBufferToString(encryptedData))

		this.queueRoomUpdate(roomID, {
			elements: decryptedData.payload.elements,
		}, socket.id)
	}

	/**
	 * Handles volatile broadcasts (e.g., mouse movements)
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {ArrayBuffer} encryptedData - Encrypted message data
	 */
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

	// IMAGE HANDLING METHODS
	/**
	 * Handles image addition to room
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {string} id - Image identifier
	 * @param {object} data - Image data
	 * @return {Promise<void>}
	 */
	async imageAddHandler(socket, roomID, id, data) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('image-data', data)

		const room = await this.storageManager.get(roomID)
		const currentFiles = { ...room.files, [id]: data }

		this.queueRoomUpdate(roomID, {
			elements: room.data,
			files: currentFiles,
		}, socket.id)
	}

	/**
	 * Handles image removal from room
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomID - Room identifier
	 * @param {string} id - Image identifier
	 */
	async imageRemoveHandler(socket, roomID, id) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('image-remove', id)

		const room = await this.storageManager.get(roomID)
		const currentFiles = { ...room.files }
		delete currentFiles[id]

		this.queueRoomUpdate(roomID, {
			elements: room.data,
			files: currentFiles,
		}, socket.id)
	}

	/**
	 * Handles image retrieval requests
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string} roomId - Room identifier
	 * @param {string} id - Image identifier
	 */
	async imageGetHandler(socket, roomId, id) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomId) || isReadOnly) return

		console.log(`[${roomId}] ${socket.id} requested image ${id}`)
		const room = await this.storageManager.get(roomId)
		const file = room.getFile(id)

		if (file) {
			socket.emit('image-data', file)
			console.log(`[${roomId}] ${socket.id} sent image data ${id}`)
		} else {
			console.warn(`[${roomId}] Image ${id} not found`)
		}
	}

	// DISCONNECTION HANDLERS
	/**
	 * Handles socket disconnection
	 * @param {Socket} socket - Socket.IO socket instance
	 */
	async disconnectHandler(socket) {
		try {
			// Clean up socket data first
			await this.socketDataStorage.delete(socket.id)

			// Remove all listeners
			socket.removeAllListeners()

			// Force disconnect if still connected
			if (socket.connected) {
				socket.disconnect(true)
			}

			Utils.logOperation('SOCKET', `Cleaned up socket: ${socket.id}`)
		} catch (error) {
			Utils.logError('SOCKET', `Failed to cleanup socket: ${socket.id}`, error)
		}
	}

	/**
	 * Handles socket disconnecting event
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {string[]} rooms - Array of room IDs
	 */
	async disconnectingHandler(socket, rooms) {
		const socketData = await this.socketDataStorage.get(socket.id)
		if (!socketData) return
		console.log(`[${socketData.fileId}] ${socketData.user.name} has disconnected`)
		console.log('socket rooms', rooms)

		for (const roomID of rooms) {
			console.log(`[${roomID}] ${socketData.user.name} has left ${roomID}`)
			const userSocketsAndIds = await this.getUserSocketsAndIds(roomID)
			const otherUserSockets = userSocketsAndIds.filter(u => u.socketId !== socket.id)

			if (otherUserSockets.length > 0) {
				this.io.to(roomID).emit('room-user-change', otherUserSockets)
			} else {
				await this.storageManager.delete(roomID)
			}

			this.queueRoomUpdate(roomID, {}, socket.id)
		}
	}

	// ROOM DATA MANAGEMENT
	/**
	 * Processes room data updates
	 * @param {string} roomID - Room identifier
	 * @param {object} updateData - Data to update
	 * @param {string} socketId - Socket identifier
	 * @return {Promise<void>}
	 */
	async processRoomDataUpdate(roomID, updateData, socketId) {
		const socketData = await this.socketDataStorage.get(socketId)
		if (!socketData) return

		const userSocketsAndIds = await this.getUserSocketsAndIds(roomID)
		const currentRoom = await this.storageManager.get(roomID)

		const roomData = {
			elements: updateData.elements || currentRoom?.data || [],
			files: updateData.files || currentRoom?.files || {},
		}

		await this.roomDataManager.syncRoomData(
			roomID,
			roomData,
			userSocketsAndIds.map(u => u.userId),
			socketData.user.id,
		)
	}

	/**
	 * Queues room updates for processing
	 * @param {string} roomID - Room identifier
	 * @param {object} updateData - Data to update
	 * @param {string} socketId - Socket identifier
	 */
	async queueRoomUpdate(roomID, updateData, socketId) {
		this.processRoomDataUpdate(roomID, updateData, socketId).catch(error => {
			console.error(`Failed to process room update for ${roomID}:`, error)
		})
	}

	// UTILITY METHODS
	/**
	 * Safely executes socket handlers with error handling
	 * @param {Socket} socket - Socket.IO socket instance
	 * @param {Function} handler - Handler function to execute
	 * @return {Promise<boolean>} Success status
	 */
	async safeSocketHandler(socket, handler) {
		try {
			const socketData = await this.socketDataStorage.get(socket.id)
			if (!socketData?.user) {
				socket.emit('error', 'Invalid session')
				socket.disconnect()
				return false
			}
			return await handler()
		} catch (error) {
			console.error('Socket handler error:', error)
			socket.emit('error', 'Internal server error')
			return false
		}
	}

	/**
	 * Checks if a socket is in read-only mode
	 * @param {string} socketId - Socket identifier
	 * @return {Promise<boolean>} Read-only status
	 */
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
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(sockets.map(async (s) => {
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
		})).then(results => results.filter(Boolean))
	}

}
