/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import jwt from 'jsonwebtoken'
import { getRoomDataFromFile, roomDataStore, saveRoomDataToFile } from './roomData.js'
import { convertArrayBufferToString, convertStringToArrayBuffer } from './utils.js'
import dotenv from 'dotenv'

dotenv.config()

const {
	NEXTCLOUD_URL = 'http://nextcloud.local',
	JWT_SECRET_KEY,
} = process.env

const verifyToken = (token) => new Promise((resolve, reject) => {
	jwt.verify(token, JWT_SECRET_KEY, (err, decoded) => {
		if (err) {
			console.log(err.name === 'TokenExpiredError' ? 'Token expired' : 'Token verification failed')

			return reject(new Error('Authentication error'))
		}

		resolve(decoded)
	})
})

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

	io.on('connection', (socket) => {
		setupSocketEvents(socket, io)
	})
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
		const token = socket.handshake.auth.token || null
		if (!token) {
			console.error('No token provided')
			next(new Error('Authentication error'))
		}

		socket.decodedData = await verifyToken(token)

		console.log(`User ${socket.decodedData.user.name} with permission ${socket.decodedData.permissions} connected`)

		if (isSocketReadOnly(socket)) {
			socket.emit('read-only')
		}

		next()
	} catch (error) {
		console.error(error.message)

		next(new Error('Authentication error'))
	}
}

const joinRoomHandler = async (socket, io, roomID) => {
	console.log(`${socket.decodedData.user.name} has joined ${roomID}`)
	await socket.join(roomID)

	if (!roomDataStore[roomID]) {
		console.log(`Data for room ${roomID} is not available, fetching from file ...`)
		roomDataStore[roomID] = await getRoomDataFromFile(roomID, socket)
	}

	socket.emit('joined-data', convertStringToArrayBuffer(JSON.stringify(roomDataStore[roomID])), [])

	const sockets = await io.in(roomID).fetchSockets()

	io.in(roomID).emit('room-user-change', sockets.map((s) => ({
		socketId: s.id,
		user: s.decodedData.user,
	})))
}

const serverBroadcastHandler = (socket, io, roomID, encryptedData, iv) => {
	if (isSocketReadOnly(socket)) return

	setTimeout(() => {
		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))

		roomDataStore[roomID] = decryptedData.payload.elements
	})

	socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)
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

		const encodedEventData = convertStringToArrayBuffer(JSON.stringify(eventData))

		socket.volatile.broadcast.to(roomID).emit('client-broadcast', encodedEventData)
	}
}

const disconnectingHandler = async (socket, io) => {
	console.log(`${socket.decodedData.user.name} has disconnected`)
	for (const roomID of Array.from(socket.rooms)) {
		if (roomID === socket.id) continue
		console.log(`${socket.decodedData.user.name} has left ${roomID}`)
		const otherClients = (await io.in(roomID).fetchSockets()).filter((s) => s.id !== socket.id)

		if (otherClients.length === 0 && roomDataStore[roomID]) {
			await saveRoomDataToFile(roomID, roomDataStore[roomID])
			// delete roomDataStore[roomID]
		}

		if (otherClients.length > 0) {
			socket.broadcast.to(roomID).emit('room-user-change', otherClients.map((s) => ({
				socketId: s.id,
				user: s.decodedData.user,
			})))
		}
	}
}

const isSocketReadOnly = (socket) => socket.decodedData.permissions === 1
