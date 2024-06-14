/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

const {
	NEXTCLOUD_URL = 'http://nextcloud.local',
	ADMIN_USER = 'admin',
	ADMIN_PASS = 'admin',
} = process.env
const FORCE_CLOSE_TIMEOUT = 60 * 1000

export let roomDataStore = {}

const fetchOptions = (method, token, body = null) => {
	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}

	if (method === 'PUT') {
		headers.Authorization = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')
	}

	return {
		method,
		headers,
		...(body && { body: JSON.stringify(body) }),
	}
}

const fetchData = async (url, options, socket = null, roomID = '') => {
	try {
		const response = await fetch(url, options)

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

		return response.json()
	} catch (error) {
		console.error(error)
		if (socket) {
			socket.emit('error', { message: 'Failed to get room data' })
			socket.leave(roomID)
		}
		return null
	}
}

export const getRoomDataFromFile = async (roomID, socket) => {
	const token = socket.handshake.auth.token
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const options = fetchOptions('GET', token)

	const result = await fetchData(url, options, socket, roomID)
	return result ? result.data.elements : null
}

export const saveRoomDataToFile = async (roomID, data) => {
	console.log(`Saving room data to file: ${roomID}`)
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const body = { data: { elements: data } }
	const options = fetchOptions('PUT', '', body)

	await fetchData(url, options)
}

export const saveAllRoomsData = async () => {
	for (const roomID in roomDataStore) {
		if (Object.prototype.hasOwnProperty.call(roomDataStore, roomID) && roomDataStore[roomID]) {
			await saveRoomDataToFile(roomID, roomDataStore[roomID])
		}
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
