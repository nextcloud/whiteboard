import fetch from 'node-fetch'

const { NEXTCLOUD_URL = 'http://nextcloud.local' } = process.env
const FORCE_CLOSE_TIMEOUT = 60 * 1000

export let roomDataStore = {}

export const getRoomDataFromFile = async (roomID, socket) => {
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

export const saveRoomDataToFile = async (roomID, data) => {
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

export const saveAllRoomsData = async () => {
	for (const roomID in roomDataStore) {
		if (roomDataStore[roomID]) await saveRoomDataToFile(roomID, roomDataStore[roomID])
	}
}

export const gracefulShutdown = async (server) => {
	console.log('Received shutdown signal, saving all data...')
	await saveAllRoomsData()
	console.log('All data saved, shutting down server...')
	roomDataStore = {}

	server.close(() => {
		console.log('HTTP server closed.')
		process.exit(0)
	})

	setTimeout(() => {
		console.error('Force closing server after 1 minute.')
		process.exit(1)
	}, FORCE_CLOSE_TIMEOUT)
}
