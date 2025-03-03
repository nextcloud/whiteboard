/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
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
		this.roomSyncers = new Map() // Map to track room syncers by user ID
	}

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
		prometheusMetrics(this.io)
		this.io.on('connection', this.handleConnection.bind(this))
	}

	handleConnection(socket) {
		socket.emit('init-room')
		this.setupSocketEventListeners(socket)
	}

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
				this.safeSocketHandler(socket, () =>
					handler.apply(this, [socket, ...args]),
				),
			)
		})

		// Handle disconnecting separately to ensure correct room capture
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
		const userId = socketData.user.id
		const userName = socketData.user.name

		console.log(`[${roomID}] ${userName} joined room`)

		await socket.join(roomID)

		// Check if this user is already the syncer for this room
		const currentSyncerUserId = this.roomSyncers.get(roomID)
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		const userSockets = await this.getUserSocketsInRoom(roomID)
		const uniqueUserIds = new Set(userSockets.map(s => s.userId))

		// If this is the first unique user and not read-only, designate as syncer
		if (uniqueUserIds.size === 1 && !isReadOnly && !currentSyncerUserId) {
			this.roomSyncers.set(roomID, userId)

			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: true,
				syncerFor: roomID,
			})

			socket.emit('sync-designate', { isSyncer: true })
			console.log(
				`[${roomID}] Designated initial syncer: ${userName}`,
			)
		} else if (currentSyncerUserId === userId) {
			// This user is already the syncer, maintain status
			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: true,
				syncerFor: roomID,
			})

			socket.emit('sync-designate', { isSyncer: true })
			console.log(
				`[${roomID}] User ${userName} reconnected as existing syncer`,
			)
		} else {
			// Not the syncer
			await this.socketDataStorage.set(socket.id, {
				...socketData,
				isSyncer: false,
			})

			socket.emit('sync-designate', { isSyncer: false })
		}

		const roomUsers = await this.getUserSocketsAndIds(roomID)
		this.io.to(roomID).emit('room-user-change', roomUsers)
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

	async imageAddHandler(socket, roomID, id, data) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('image-data', data)
	}

	async imageRemoveHandler(socket, roomID, id) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('image-remove', id)
	}

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

			// Check if user was syncer and if they have other active connections in the room
			const wasSyncer = this.roomSyncers.get(roomID) === userId

			if (wasSyncer) {
				// Check if the user has other connections in the room before finding a new syncer
				const userSockets = await this.getUserSocketsInRoom(roomID)
				const userStillConnected = userSockets
					.filter(s => s.socketId !== socket.id)
					.some(s => s.userId === userId)

				if (!userStillConnected) {
					console.log(
						`[${roomID}] Syncer disconnected (all sessions), finding new syncer`,
					)
					await this.findNewSyncer(roomID)
				} else {
					console.log(
						`[${roomID}] Syncer disconnected but has other active connections, maintaining syncer status`,
					)
				}
			}

			const roomUsers = await this.getUserSocketsAndIds(roomID)
			socket.to(roomID).emit('room-user-change', roomUsers)
		}
	}

	async findNewSyncer(roomID) {
		const userSockets = await this.getUserSocketsInRoom(roomID)

		// Group sockets by user ID
		const userMap = new Map()
		userSockets.forEach(s => {
			if (!userMap.has(s.userId)) {
				userMap.set(s.userId, [])
			}
			userMap.get(s.userId).push(s)
		})

		if (userMap.size === 0) {
			console.log(`[${roomID}] No users left in room, no syncer needed`)
			this.roomSyncers.delete(roomID)
			return
		}

		// Try to find a non-readonly user to become syncer
		for (const [userId, sockets] of userMap.entries()) {
			// Check if any of the user's sockets is not read-only
			for (const socketInfo of sockets) {
				const isReadOnly = await this.isSocketReadOnly(socketInfo.socketId)

				if (!isReadOnly) {
					// Found an eligible user, make them the syncer
					this.roomSyncers.set(roomID, userId)

					// Update all sockets for this user
					for (const s of sockets) {
						const socketData = await this.socketDataStorage.get(s.socketId)
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

					console.log(
						`[${roomID}] Promoted new syncer: ${sockets[0].userName}`,
					)
					return
				}
			}
		}

		console.log(`[${roomID}] No eligible users found for syncer role`)
		this.roomSyncers.delete(roomID)
	}

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
		).then((results) => results.filter(Boolean))
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
