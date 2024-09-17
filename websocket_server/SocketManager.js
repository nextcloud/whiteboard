/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import Utils from './Utils.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import SocketDataManager from './SocketDataManager.js'

dotenv.config()

export default class SocketManager {

	constructor(server, roomDataManager, storageManager) {
		this.roomDataManager = roomDataManager
		this.storageManager = storageManager
		this.socketDataManager = new SocketDataManager(storageManager)

		this.io = new SocketIO(server, {
			transports: ['websocket'],
			cors: {
				origin: process.env.NEXTCLOUD_URL || 'http://nextcloud.local',
				methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				credentials: true,
			},
		})

		this.init()
	}

	async init() {
		if (this.shouldUseRedis()) {
			await this.setupRedisStreamsAdapter()
		} else {
			console.log('Using default in-memory adapter')
		}

		this.io.use(this.socketAuthenticateHandler.bind(this))
		prometheusMetrics(this.io)
		this.io.on('connection', this.handleConnection.bind(this))
	}

	shouldUseRedis() {
		return this.storageManager.strategy.constructor.name === 'RedisStrategy'
	}

	async setupRedisStreamsAdapter() {
		console.log('Setting up Redis Streams adapter')
		try {
			const redisClient = this.storageManager.strategy.client
			this.io.adapter(
				createAdapter(redisClient, {
					maxLen: 10000,
				}),
			)

			console.log('Redis Streams adapter set up successfully')
		} catch (error) {
			console.error('Failed to set up Redis Streams adapter:', error)
			console.log('Falling back to in-memory adapter')
		}
	}

	async socketAuthenticateHandler(socket, next) {
		try {
			const { token } = socket.handshake.auth
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			console.log('decodedData', decodedData)
			await this.socketDataManager.setSocketData(socket.id, decodedData)

			if (decodedData.isFileReadOnly) {
				socket.emit('read-only')
			}
			next()
		} catch (error) {
			const { secret } = socket.handshake.auth

			try {
				jwt.verify(
					secret,
					process.env.JWT_SECRET_KEY,
					{
						algorithm: 'HS256',
					},
				)
				next(new Error('Connection verified'))
			} catch (e) {}

			next(new Error('Authentication error'))
		}
	}

	handleConnection(socket) {
		socket.emit('init-room')
		socket.on('join-room', (roomID) => this.joinRoomHandler(socket, roomID))
		socket.on('server-broadcast', (roomID, encryptedData, iv) =>
			this.serverBroadcastHandler(socket, roomID, encryptedData, iv),
		)
		socket.on('server-volatile-broadcast', (roomID, encryptedData) =>
			this.serverVolatileBroadcastHandler(socket, roomID, encryptedData),
		)
		socket.on('image-add', (roomID, id, data) => this.imageAddHandler(socket, roomID, id, data))
		socket.on('image-remove', (roomID, id, data) => this.imageRemoveHandler(socket, roomID, id, data))
		socket.on('image-get', (roomID, id, data) => this.imageGetHandler(socket, roomID, id, data))
		socket.on('disconnecting', () => {
			const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id)
			this.disconnectingHandler(socket, rooms)
		})
		socket.on('disconnect', () => this.handleDisconnect(socket))
	}

	async handleDisconnect(socket) {
		await this.socketDataManager.deleteSocketData(socket.id)
		socket.removeAllListeners()
	}

	async verifyToken(token) {
		const cachedToken = await this.socketDataManager.getCachedToken(token)
		if (cachedToken) return cachedToken

		return new Promise((resolve, reject) => {
			jwt.verify(
				token,
				process.env.JWT_SECRET_KEY,
				async (err, decoded) => {
					if (err) {
						console.log(
							err.name === 'TokenExpiredError'
								? 'Token expired'
								: 'Token verification failed',
						)
						return reject(new Error('Authentication error'))
					}
					await this.socketDataManager.setCachedToken(token, decoded)
					resolve(decoded)
				},
			)
		})
	}

	async isSocketReadOnly(socketId) {
		const socketData = await this.socketDataManager.getSocketData(socketId)
		return socketData ? !!socketData.isFileReadOnly : false
	}

	async getUserSocketsAndIds(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(sockets.map(async (s) => {
			const data = await this.socketDataManager.getSocketData(s.id)
			return {
				socketId: s.id,
				user: data.user,
				userId: data.user.id,
			}
		}))
	}

	async joinRoomHandler(socket, roomID) {
		console.log(`[${roomID}] ${socket.id} has joined ${roomID}`)
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

	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(Utils.convertArrayBufferToString(encryptedData))
		const socketData = await this.socketDataManager.getSocketData(socket.id)
		if (!socketData) return
		const userSocketsAndIds = await this.getUserSocketsAndIds(roomID)

		await this.roomDataManager.syncRoomData(
			roomID,
			decryptedData.payload.elements,
			userSocketsAndIds.map(u => u.userId),
			socketData.user.id,
		)
	}

	async serverVolatileBroadcastHandler(socket, roomID, encryptedData) {
		const payload = JSON.parse(
			Utils.convertArrayBufferToString(encryptedData),
		)

		if (payload.type === 'MOUSE_LOCATION') {
			const socketData = await this.socketDataManager.getSocketData(
				socket.id,
			)
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
		const room = await this.storageManager.get(roomID)

		console.log(`[${roomID}] ${socket.id} added image ${id}`)
		room.addFile(id, data)
		this.storageManager.set(roomID, room)
	}

	async imageRemoveHandler(socket, roomID, id) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('image-remove', id)
		const room = await this.storageManager.get(roomID)
		room.removeFile(id)
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

	async disconnectingHandler(socket, rooms) {
		const socketData = await this.socketDataManager.getSocketData(socket.id)
		if (!socketData) return
		console.log(`[${socketData.fileId}] ${socketData.user.name} has disconnected`)
		console.log('socket rooms', rooms)

		for (const roomID of rooms) {
			console.log(`[${roomID}] ${socketData.user.name} has left ${roomID}`)

			const userSocketsAndIds = await this.getUserSocketsAndIds(roomID)
			const otherUserSockets = userSocketsAndIds.filter(u => u.socketId !== socket.id)

			if (otherUserSockets.length > 0) {
				this.io.to(roomID).emit('room-user-change', userSocketsAndIds)
			}

			await this.roomDataManager.syncRoomData(roomID, null, userSocketsAndIds.map(u => u.userId))
		}
	}

}
