/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import {
	addUserToRoom,
	removeUserFromRoom,
	updateLastEditedUser,
	getRoomData,
	setRoomData,
	getRoomDataFromFile,
	handleEmptyRoom,
} from './roomData.js'
import { convertArrayBufferToString, convertStringToArrayBuffer } from './utils.js'
import dotenv from 'dotenv'
import { LRUCache } from 'lru-cache'

dotenv.config()

const {
	NEXTCLOUD_URL = 'http://nextcloud.local',
	JWT_SECRET_KEY,
} = process.env

const TOKEN_CACHE_TTL = 10 * 60 * 1000 // 10 minutes, << JWT expiration time
const tokenCache = new LRUCache({
	ttl: TOKEN_CACHE_TTL,
	updateAgeOnGet: false,
	max: 1000,
})

export const removeTokenFromCache = (token) => {
	tokenCache.delete(token)
}

const verifyToken = async (token) => {
	if (tokenCache.has(token)) {
		return tokenCache.get(token)
	}

	return new Promise((resolve, reject) => {
		jwt.verify(token, JWT_SECRET_KEY, (err, decoded) => {
			if (err) {
				console.log(err.name === 'TokenExpiredError' ? 'Token expired' : 'Token verification failed')
				return reject(new Error('Authentication error'))
			}
			tokenCache.set(token, decoded)
			resolve(decoded)
		})
	})
}

export const initSocket = (server) => {
	const io = new SocketIO(server, {
		transports: ['websocket', 'polling'],
		cors: {
			origin: NEXTCLOUD_URL,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			credentials: true,
		},
	})

	io.use(socketAuthenticateHandler)
	prometheusMetrics(io)
	io.on('connection', (socket) => setupSocketEvents(socket, io))
}

const setupSocketEvents = (socket, io) => {
	socket.emit('init-room')
	socket.on('join-room', (roomID) => joinRoomHandler(socket, io, roomID))
	socket.on('server-broadcast', (roomID, encryptedData, iv) => serverBroadcastHandler(socket, io, roomID, encryptedData, iv))
	socket.on('server-volatile-broadcast', (roomID, encryptedData) => serverVolatileBroadcastHandler(socket, roomID, encryptedData))
	socket.on('disconnecting', () => disconnectingHandler(socket, io))
	socket.on('disconnect', () => socket.removeAllListeners())
}

const socketAuthenticateHandler = async (socket, next) => {
	try {
		const token = socket.handshake.auth.token
		if (!token) throw new Error('No token provided')

		socket.decodedData = await verifyToken(token)
		console.log(`[${socket.decodedData.fileId}] User ${socket.decodedData.user.id} with permission ${socket.decodedData.permissions} connected`)

		if (isSocketReadOnly(socket)) socket.emit('read-only')
		next()
	} catch (error) {
		console.error(error.message)
		next(new Error('Authentication error'))
	}
}

const joinRoomHandler = async (socket, io, roomID) => {
	console.log(`[${roomID}] ${socket.decodedData.user.id} has joined ${roomID}`)
	await socket.join(roomID)
	addUserToRoom(roomID, socket.decodedData.user.id)

	let roomData = getRoomData(roomID)
	if (!roomData) {
		console.log(`[${roomID}] Data for room ${roomID} is not available, fetching from file ...`)
		roomData = await getRoomDataFromFile(roomID, socket.handshake.auth.token)
		setRoomData(roomID, roomData)
	}

	socket.emit('joined-data', convertStringToArrayBuffer(JSON.stringify(roomData)), [])

	const userSockets = await getUserSockets(io, roomID, socket.id)
	io.in(roomID).emit('room-user-change', userSockets)
}

const serverBroadcastHandler = (socket, io, roomID, encryptedData, iv) => {
	if (!socket.rooms.has(roomID) || !getRoomData(roomID) || isSocketReadOnly(socket)) return

	socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

	setTimeout(() => {
		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))
		setRoomData(roomID, decryptedData.payload.elements)
		updateLastEditedUser(roomID, socket.decodedData.user.id)
	})
}

const serverVolatileBroadcastHandler = (socket, roomID, encryptedData) => {
	const payload = JSON.parse(convertArrayBufferToString(encryptedData))

	if (payload.type === 'MOUSE_LOCATION') {
		const eventData = {
			type: 'MOUSE_LOCATION',
			payload: {
				...payload.payload,
				user: socket.decodedData.user,
			},
		}
		socket.volatile.broadcast.to(roomID).emit('client-broadcast', convertStringToArrayBuffer(JSON.stringify(eventData)))
	}
}

const disconnectingHandler = async (socket, io) => {
	console.log(`[${socket.decodedData.fileId}] ${socket.decodedData.user.name} has disconnected`)
	const rooms = new Set(socket.rooms)
	for (const roomID of rooms) {
		if (roomID === socket.id) continue
		console.log(`[${roomID}] ${socket.decodedData.user.name} has left ${roomID}`)

		const otherClients = await getUserSockets(io, roomID, socket.id)

		if (otherClients.length === 0) {
			await handleEmptyRoom(roomID)
		} else {
			socket.broadcast.to(roomID).emit('room-user-change', otherClients)
		}

		removeUserFromRoom(roomID, socket.decodedData.user.id)
	}
}

const getUserSockets = async (io, roomID, currentSocketId) => {
	const sockets = await io.in(roomID).fetchSockets()
	return sockets
		.filter(s => s.id !== currentSocketId)
		.map(s => ({
			socketId: s.id,
			user: s.decodedData.user,
		}))
}

const isSocketReadOnly = (socket) => socket.decodedData.permissions === 1
