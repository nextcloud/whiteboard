/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import { LRUCache } from 'lru-cache'
import Utils from './utils.js'

dotenv.config()

class SocketManager {

	constructor(server, roomDataManager) {
		this.roomDataManager = roomDataManager
		this.io = new SocketIO(server, {
			transports: ['websocket', 'polling'],
			cors: {
				origin: process.env.NEXTCLOUD_URL || 'http://nextcloud.local',
				methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				credentials: true,
			},
		})

		this.tokenCache = new LRUCache({
			ttl: 10 * 60 * 1000, // 10 minutes
			ttlAutopurge: true,
			updateAgeOnGet: false,
		})

		this.init()
	}

	init() {
		this.io.use(this.socketAuthenticateHandler.bind(this))
		prometheusMetrics(this.io)
		this.io.on('connection', this.handleConnection.bind(this))
	}

	async verifyToken(token) {
		if (this.tokenCache.has(token)) return this.tokenCache.get(token)

		return new Promise((resolve, reject) => {
			jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
				if (err) {
					console.log(err.name === 'TokenExpiredError' ? 'Token expired' : 'Token verification failed')
					return reject(new Error('Authentication error'))
				}
				this.tokenCache.set(token, decoded)
				resolve(decoded)
			})
		})
	}

	async socketAuthenticateHandler(socket, next) {
		try {
			const { token } = socket.handshake.auth
			if (!token) throw new Error('No token provided')

			socket.decodedData = await this.verifyToken(token)
			console.log(`[${socket.decodedData.fileId}] User ${socket.decodedData.user.id} with permission ${socket.decodedData.permissions} connected`)

			this.isSocketReadOnly(socket) && socket.emit('read-only')
			next()
		} catch (error) {
			console.error(error.message)
			next(new Error('Authentication error'))
		}
	}

	handleConnection(socket) {
		socket.emit('init-room')
		socket.on('join-room', (roomID) => this.joinRoomHandler(socket, roomID))
		socket.on('server-broadcast', (roomID, encryptedData, iv) => this.serverBroadcastHandler(socket, roomID, encryptedData, iv))
		socket.on('server-volatile-broadcast', (roomID, encryptedData) => this.serverVolatileBroadcastHandler(socket, roomID, encryptedData))
		socket.on('disconnecting', () => this.disconnectingHandler(socket))
		socket.on('disconnect', () => socket.removeAllListeners())
	}

	async joinRoomHandler(socket, roomID) {
		console.log(`[${roomID}] ${socket.decodedData.user.id} has joined ${roomID}`)
		await socket.join(roomID)

		const userSockets = await this.getUserSockets(roomID)
		const userIds = userSockets.map(s => s.user.id)

		const room = await this.roomDataManager.syncRoomData(roomID, null, userIds, null, socket.handshake.auth.token)

		if (room) {
			socket.emit('joined-data', Utils.convertStringToArrayBuffer(JSON.stringify(room.data)), [])

			const otherUserSockets = await this.getOtherUserSockets(roomID, socket.id)
			this.io.in(roomID).emit('room-user-change', otherUserSockets)
		} else {
			socket.emit('room-not-found')
		}
	}

	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		if (!socket.rooms.has(roomID) || this.isSocketReadOnly(socket)) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(Utils.convertArrayBufferToString(encryptedData))
		const userId = socket.decodedData.user.id
		const userSockets = await this.getUserSockets(roomID)
		const userIds = userSockets.map(s => s.user.id)

		await this.roomDataManager.syncRoomData(roomID, decryptedData.payload.elements, userIds, userId)
	}

	serverVolatileBroadcastHandler(socket, roomID, encryptedData) {
		const payload = JSON.parse(Utils.convertArrayBufferToString(encryptedData))

		if (payload.type === 'MOUSE_LOCATION') {
			const eventData = {
				type: 'MOUSE_LOCATION',
				payload: {
					...payload.payload,
					user: socket.decodedData.user,
				},
			}

			socket.volatile.broadcast.to(roomID).emit('client-broadcast', Utils.convertStringToArrayBuffer(JSON.stringify(eventData)))
		}
	}

	async disconnectingHandler(socket) {
		console.log(`[${socket.decodedData.fileId}] ${socket.decodedData.user.name} has disconnected`)
		for (const roomID of socket.rooms) {
			if (roomID === socket.id) continue
			console.log(`[${roomID}] ${socket.decodedData.user.name} has left ${roomID}`)

			const otherUserSockets = await this.getOtherUserSockets(roomID, socket.id)

			otherUserSockets.length > 0 && socket.broadcast.to(roomID).emit('room-user-change', otherUserSockets)

			const userSockets = await this.getUserSockets(roomID)
			const userIds = userSockets.map(s => s.user.id)

			await this.roomDataManager.syncRoomData(roomID, null, userIds)
		}
	}

	async getUserSockets(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return sockets.map(s => ({
			socketId: s.id,
			user: s.decodedData.user,
		}))
	}

	async getOtherUserSockets(roomID, currentSocketId) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return sockets
			.filter(s => s.id !== currentSocketId)
			.map(s => ({
				socketId: s.id,
				user: s.decodedData.user,
			}))
	}

	isSocketReadOnly(socket) {
		return socket.decodedData.permissions === 1
	}

}

export default SocketManager
