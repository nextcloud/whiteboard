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

export const initSocket = (server) => {
	const io = new SocketIO(server, {
		transports: ['websocket', 'polling'],
		cors: {
			origin: NEXTCLOUD_URL,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			credentials: true,
		},
	})

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
}
