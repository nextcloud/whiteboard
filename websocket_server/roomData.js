/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

const {
	NEXTCLOUD_URL = 'http://nextcloud.local',
	ADMIN_USER = 'admin',
	ADMIN_PASS = 'admin',
} = process.env

export const roomDataStore = {}

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

// Called when there's nobody in the room (No one keeping the latest data), BE to BE communication
export const saveRoomDataToFile = async (roomID, data) => {
	console.log(`[${roomID}] Saving room data to file: ${roomID}`)
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const body = { data: { elements: data } }
	const options = fetchOptions('PUT', '', body)

	await fetchData(url, options)
}

// TODO: Should be called when the server is shutting down and a should be a BE to BE (or OS) communication
//  in batch operation, run in background and check if it's necessary to save for each room.
//  Should be called periodically and saved somewhere else for preventing data loss (memory loss, server crash, electricity cut, etc.)
export const saveAllRoomsData = async () => {
}

export const removeAllRoomData = async () => {
	for (const roomID in roomDataStore) {
		if (Object.prototype.hasOwnProperty.call(roomDataStore, roomID)) {
			delete roomDataStore[roomID]
		}
	}
}
