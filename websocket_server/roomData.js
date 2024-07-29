/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fetch from 'node-fetch'
import dotenv from 'dotenv'
import { generateSharedToken } from './auth.js'
import https from 'https'
import { parseBooleanFromEnv } from './utils.js'
import { LRUCache } from 'lru-cache'

dotenv.config()

const {
	NEXTCLOUD_URL,
	IS_DEV,
} = process.env

const agent = parseBooleanFromEnv(IS_DEV) ? new https.Agent({ rejectUnauthorized: false }) : null

const INACTIVE_THRESHOLD = 30 * 60 * 1000 // 30 minutes
const MAX_ROOMS = 100

class Room {

	constructor(id) {
		this.id = id
		this.data = null
		this.users = {}
		this.lastEditedUser = null
		this.lastActivity = Date.now()
	}

	addUser(userId) {
		this.users[userId] = true
		this.updateActivity()
	}

	removeUser(userId) {
		delete this.users[userId]
		this.updateActivity()
	}

	updateLastEditedUser(userId) {
		this.lastEditedUser = userId
		this.updateActivity()
	}

	setData(data) {
		this.data = data
		this.updateActivity()
	}

	isEmpty() {
		return Object.keys(this.users).length === 0
	}

	updateActivity() {
		this.lastActivity = Date.now()
	}

}

export const rooms = new LRUCache({
	max: MAX_ROOMS,
	ttl: INACTIVE_THRESHOLD,
	updateAgeOnGet: true,
	dispose: async (value, key) => {
		console.log('Disposing room', key)

		if (value && value.data && value.lastEditedUser) {
			try {
				await saveRoomDataToFile(key, value.data, value.lastEditedUser)
			} catch (error) {
				console.error(`Failed to save room ${key} data:`, error)
			}
		}
	},
})

const fetchOptions = (method, token, body = null, roomId = null, lastEditedUser = null) => ({
	method,
	headers: {
		'Content-Type': 'application/json',
		...(method === 'GET' && { Authorization: `Bearer ${token}` }),
		...(method === 'PUT' && {
			'X-Whiteboard-Auth': generateSharedToken(roomId),
			'X-Whiteboard-User': lastEditedUser || 'unknown',
		}),
	},
	...(body && { body: JSON.stringify(body) }),
	...(agent && { agent }),
})

const fetchData = async (url, options) => {
	try {
		const response = await fetch(url, options)
		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`HTTP error! status: ${response.status}: ${errorText}`)
		}
		return response.json()
	} catch (error) {
		console.error(error)
		return null
	}
}

export const getOrCreateRoom = (roomId) => {
	let room = rooms.get(roomId)
	if (!room) {
		room = new Room(roomId)
		rooms.set(roomId, room)
	}
	return room
}

export const addUserToRoom = (roomId, userId) => {
	const room = getOrCreateRoom(roomId)
	room.addUser(userId)
}

export const removeUserFromRoom = (roomId, userId) => {
	const room = rooms.get(roomId)
	if (room) {
		room.removeUser(userId)
		if (room.isEmpty()) {
			rooms.delete(roomId)
		}
	}
}

export const updateLastEditedUser = (roomId, userId) => {
	const room = rooms.get(roomId)
	if (room) {
		room.updateLastEditedUser(userId)
	}
}

export const getRoomData = (roomId) => {
	console.log('Getting data from memory for room', roomId)
	const room = rooms.get(roomId)
	return room ? room.data : null
}

export const setRoomData = (roomId, data) => {
	const room = getOrCreateRoom(roomId)
	room.setData(data)
}

export const getRoomDataFromFile = async (roomID, jwtToken) => {
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const options = fetchOptions('GET', jwtToken)
	const result = await fetchData(url, options)
	const elements = result?.data?.elements
	if (elements) {
		setRoomData(roomID, elements)
	}
	return elements || null
}

export const saveRoomDataToFile = async (roomID, roomData, lastEditedUser) => {
	console.log('Saving room data to file', roomID)
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const body = { data: { elements: roomData } }
	const options = fetchOptions('PUT', null, body, roomID, lastEditedUser)
	await fetchData(url, options)
}

export const handleEmptyRoom = async (roomID) => {
	const roomData = getRoomData(roomID)
	if (roomData) {
		rooms.delete(roomID) // This will trigger the dispose function so that the data is saved to file
	}
}

export const saveAllRoomsData = () =>
	Promise.all(Array.from(rooms.entries()).map(([roomId, room]) =>
		saveRoomDataToFile(roomId, room.data)))

export const removeAllRoomData = () => {
	rooms.clear()
}
