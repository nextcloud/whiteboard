/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import express from 'express'
import http from 'http'
import https from 'https'
import { Server as SocketIO } from 'socket.io'
import fetch from 'node-fetch'
import * as fs from 'node:fs'

const nextcloudUrl = process.env.NEXTCLOUD_URL || 'http://nextcloud.local'
const port = process.env.PORT || 3002

const tls = process.env.TLS || false
const key = process.env.TLS_KEY || undefined
const cert = process.env.TLS_CERT || undefined

const app = express()

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)')
})

const server = (tls ? https : http).createServer({
	key: key ? fs.readFileSync(key) : undefined,
	cert: cert ? fs.readFileSync(cert) : undefined,
}, app)

let roomDataStore = {}

const getRoomDataFromFile = async (roomID) => {
	const response = await fetch(`${nextcloudUrl}/index.php/apps/whiteboard/${roomID}`, {
		headers: {
			Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'),
		},
	})

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`)
	}

	const data = await response.json()
	const roomData = data.data

	return JSON.stringify(roomData.elements)
}

const convertStringToArrayBuffer = (string) => {
	return new TextEncoder().encode(string).buffer
}

const convertArrayBufferToString = (arrayBuffer) => {
	return new TextDecoder().decode(arrayBuffer)
}

const saveRoomDataToFile = async (roomID, data) => {
	console.info(`Saving room data to file: ${roomID}`)

	const body = JSON.stringify({ data: { elements: data } })

	try {
		await fetch(`${nextcloudUrl}/index.php/apps/whiteboard/${roomID}`, {
			method: 'PUT',
			headers: {
				Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'),
				'Content-Type': 'application/json',
			},
			body,
		})
	} catch (error) {
		console.error(error)
	}
}

const saveAllRoomsData = async () => {
	for (const roomID in roomDataStore) {
		if (roomDataStore[roomID]) {
			await saveRoomDataToFile(roomID, roomDataStore[roomID])
		}
	}
}

const io = new SocketIO(server, {
	transports: ['websocket', 'polling'],
	cors: {
		allowedHeaders: ['X-Requested-With', 'Content-Type', 'Authorization'],
		origin: '*',
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	},
	allowEIO3: true,
})

io.on('connection', async (socket) => {
	io.to(`${socket.id}`).emit('init-room')

	socket.on('join-room', async (roomID) => {
		console.debug(`${socket.id} has joined ${roomID}`)
		await socket.join(roomID)

		if (!roomDataStore[roomID]) {
			roomDataStore[roomID] = await getRoomDataFromFile(roomID)
		}

		socket.emit('joined-data', convertStringToArrayBuffer(roomDataStore[roomID]), [])

		const sockets = await io.in(roomID).fetchSockets()

		if (sockets.length <= 1) {
			io.to(`${socket.id}`).emit('first-in-room')
		} else {
			console.debug(`${socket.id} new-user emitted to room ${roomID}`)
			socket.broadcast.to(roomID).emit('new-user', socket.id)
		}

		io.in(roomID).emit('room-user-change', sockets.map((socket) => socket.id))
	})

	socket.on('server-broadcast', (roomID, encryptedData, iv) => {
		console.debug(`Broadcasting to room ${roomID}`)

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))

		setTimeout(() => {
			roomDataStore[roomID] = decryptedData.payload.elements
		})
	})

	socket.on('server-volatile-broadcast', (roomID, encryptedData, iv) => {
		console.debug(`Volatile broadcasting to room ${roomID}`)

		socket.volatile.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(convertArrayBufferToString(encryptedData))

		console.debug(decryptedData.payload)

		// setTimeout(() => {
		// roomDataStore[roomID] = decryptedData.payload.elements
		// })
	})

	socket.on('user-follow', async (payload) => {
		console.debug(`User follow action: ${JSON.stringify(payload)}`)
		const roomID = `follow@${payload.userToFollow.socketId}`

		switch (payload.action) {
		case 'FOLLOW': {
			await socket.join(roomID)

			const sockets = await io.in(roomID).fetchSockets()
			const followedBy = sockets.map((socket) => socket.id)

			io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy)

			break
		}
		case 'UNFOLLOW': {
			await socket.leave(roomID)

			const sockets = await io.in(roomID).fetchSockets()
			const followedBy = sockets.map((socket) => socket.id)

			io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy)

			break
		}
		}
	})

	socket.on('disconnecting', async () => {
		console.debug(`${socket.id} has disconnected`)

		for (const roomID of Array.from(socket.rooms)) {
			if (roomID === socket.id) continue

			console.debug(`${socket.id} has left ${roomID}`)

			const otherClients = (await io.in(roomID).fetchSockets()).filter((_socket) => _socket.id !== socket.id)

			// Save room data if no one is in the room
			if (otherClients.length === 0 && roomDataStore[roomID]) {
				await saveRoomDataToFile(roomID, roomDataStore[roomID])

				// Flush room data if no one is in the room
				delete roomDataStore[roomID]
			}

			const isFollowRoom = roomID.startsWith('follow@')

			if (!isFollowRoom && otherClients.length > 0) {
				socket.broadcast.to(roomID).emit('room-user-change', otherClients.map((socket) => socket.id))
			}

			if (isFollowRoom && otherClients.length === 0) {
				const socketId = roomID.replace('follow@', '')
				io.to(socketId).emit('broadcast-unfollow')
			}
		}
	})

	socket.on('disconnect', async () => {
		socket.removeAllListeners()
		socket.disconnect()
	})
})

// Save all rooms data every 1 hour
const interval = setInterval(saveAllRoomsData, 60 * 60 * 1000)

// Graceful Shutdown
const gracefulShutdown = async () => {
	console.debug('Received shutdown signal, saving all data...')
	await saveAllRoomsData()
	console.debug('All data saved, shutting down server...')
	clearInterval(interval)
	roomDataStore = {}

	// Close the server gracefully
	server.close(() => {
		console.debug('HTTP server closed.')

		// eslint-disable-next-line n/no-process-exit
		process.exit(0)
	})

	// Force close the server if it doesn't close within 1 minute
	setTimeout(() => {
		console.error('Force closing server after 1 minute.')

		// eslint-disable-next-line n/no-process-exit
		process.exit(1)
	}, 60 * 1000)

	io.close(() => {
		console.debug('Socket server closed.')
	})
}

// Handle shutdown signals
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

server.listen(port, () => {
	console.debug(`listening on port: ${port}`)
})
