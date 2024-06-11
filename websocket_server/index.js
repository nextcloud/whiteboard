/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

import express from 'express'
import http from 'http'
import https from 'https'
import { Server as SocketIO } from 'socket.io'
import fetch from 'node-fetch'
import jwt from 'jsonwebtoken'
import * as fs from 'node:fs'

const {
	NEXTCLOUD_URL = 'http://nextcloud.local',
	PORT = 3002,
	TLS = false,
	TLS_KEY: key,
	TLS_CERT: cert,
	JWT_SECRET_KEY,
} = process.env

const app = express()
const server = (TLS ? https : http).createServer(
	{
		key: key ? fs.readFileSync(key) : undefined,
		cert: cert ? fs.readFileSync(cert) : undefined,
	},
	app,
)

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)')
})

const io = new SocketIO(server, {
	transports: ['websocket', 'polling'],
	cors: {
		origin: NEXTCLOUD_URL,
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		credentials: true,
	},
})

let roomDataStore = {}

const getRoomDataFromFile = async (roomID, socket) => {
	try {
		const token = socket.handshake.auth.token
		const response = await fetch(`${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
		})

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

		const { data: roomData } = await response.json()
		return roomData.elements
	} catch (error) {
		console.error(error)
		socket.emit('error', { message: 'Failed to get room data' })
		socket.leave(roomID)
		return null
	}
}

const convertStringToArrayBuffer = (string) => new TextEncoder().encode(string).buffer
const convertArrayBufferToString = (arrayBuffer) => new TextDecoder().decode(arrayBuffer)

const saveRoomDataToFile = async (roomID, data) => {
	console.log(`Saving room data to file: ${roomID}`)

	const body = JSON.stringify({ data: { elements: data } })

	try {
		await fetch(`${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'),
			},
			body,
		})
	} catch (error) {
		console.error(error)
	}
}

const saveAllRoomsData = async () => {
	for (const roomID in roomDataStore) {
		if (roomDataStore[roomID]) await saveRoomDataToFile(roomID, roomDataStore[roomID])
	}
}

const verifyToken = (socket, next) => {
	const token = socket.handshake.auth.token

	if (!token) {
		console.log('No token provided')
		return next(new Error('Authentication error'))
	}

	jwt.verify(token, JWT_SECRET_KEY, (err, decoded) => {
		if (err) {
			console.log(err.name === 'TokenExpiredError' ? 'Token expired' : 'Token verification failed')
			return next(new Error('Authentication error'))
		}

		socket.user = decoded
		next()
	})
}

io.use(verifyToken)

io.on('connection', (socket) => {
	io.to(socket.id).emit('init-room')

	socket.use((packet, next) => {
		jwt.verify(socket.handshake.auth.token, JWT_SECRET_KEY, (err, decoded) => {
			console.log('Verifying token ...')

			if (err) {
				console.log('Token invalid')
				socket.emit(err.name === 'TokenExpiredError' ? 'token-expired' : 'invalid-token')
				return next(new Error('Authentication error'))
			}

			socket.user = decoded
			next()
		})
	})

	socket.on('join-room', async (roomID) => {
		console.log(`${socket.id} has joined ${roomID}`)
		await socket.join(roomID)

		if (!roomDataStore[roomID]) {
			console.log(`Data for room ${roomID} is not available, fetching from file ...`)
			roomDataStore[roomID] = await getRoomDataFromFile(roomID, socket)
		}

		socket.emit('joined-data', convertStringToArrayBuffer(JSON.stringify(roomDataStore[roomID])), [])
		const sockets = await io.in(roomID).fetchSockets()

		if (sockets.length <= 1) {
			io.to(socket.id).emit('first-in-room')
		} else {
			console.log(`${socket.id} new-user emitted to room ${roomID}`)
			socket.broadcast.to(roomID).emit('new-user', socket.id)
		}

		io.in(roomID).emit('room-user-change', sockets.map((s) => s.id))
	})

	socket.on('server-broadcast', (roomID, encryptedData, iv) => {
		console.log(`Broadcasting to room ${roomID}`)
		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))
		setTimeout(() => {
			roomDataStore[roomID] = decryptedData.payload.elements
		})
	})

	socket.on('server-volatile-broadcast', (roomID, encryptedData, iv) => {
		console.log(`Volatile broadcasting to room ${roomID}`)
		socket.volatile.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))
		console.log(decryptedData.payload)
	})

	socket.on('user-follow', async (payload) => {
		console.log(`User follow action: ${JSON.stringify(payload)}`)
		const roomID = `follow@${payload.userToFollow.socketId}`

		switch (payload.action) {
		case 'FOLLOW':
			await socket.join(roomID)
			break
		case 'UNFOLLOW':
			await socket.leave(roomID)
			break
		}

		const sockets = await io.in(roomID).fetchSockets()
		const followedBy = sockets.map((s) => s.id)
		io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy)
	})

	const handleDisconnect = async () => {
		console.log(`${socket.id} has disconnected`)
		for (const roomID of Array.from(socket.rooms)) {
			if (roomID === socket.id) continue
			console.log(`${socket.id} has left ${roomID}`)
			const otherClients = (await io.in(roomID).fetchSockets()).filter((s) => s.id !== socket.id)

			if (otherClients.length === 0 && roomDataStore[roomID]) {
				await saveRoomDataToFile(roomID, roomDataStore[roomID])
				delete roomDataStore[roomID]
			}

			if (!roomID.startsWith('follow@') && otherClients.length > 0) {
				socket.broadcast.to(roomID).emit('room-user-change', otherClients.map((s) => s.id))
			}

			if (roomID.startsWith('follow@') && otherClients.length === 0) {
				const socketId = roomID.replace('follow@', '')
				io.to(socketId).emit('broadcast-unfollow')
			}
		}
	}

	socket.on('disconnecting', handleDisconnect)
	socket.on('disconnect', () => {
		socket.removeAllListeners()
		socket.disconnect()
	})
})

const interval = setInterval(saveAllRoomsData, 60 * 60 * 1000)

const gracefulShutdown = async () => {
	console.log('Received shutdown signal, saving all data...')
	await saveAllRoomsData()
	console.log('All data saved, shutting down server...')
	clearInterval(interval)
	roomDataStore = {}

	server.close(() => {
		console.log('HTTP server closed.')
		process.exit(0)
	})

	setTimeout(() => {
		console.error('Force closing server after 1 minute.')
		process.exit(1)
	}, 60 * 1000)

	io.close(() => {
		console.log('Socket server closed.')
	})
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

server.listen(PORT, () => {
	console.log(`Listening on port: ${PORT}`)
})
