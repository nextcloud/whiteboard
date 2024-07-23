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

dotenv.config()

const {
	NEXTCLOUD_URL,
	IS_DEV,
} = process.env

const agent = parseBooleanFromEnv(IS_DEV) ? new https.Agent({ rejectUnauthorized: false }) : null

export const roomDataStore = {}
export const roomUsers = new Map()
export const lastEditedUser = new Map()

const fetchOptions = (method, token, body = null, roomId = null) => ({
	method,
	headers: {
		'Content-Type': 'application/json',
		...(method === 'GET' && { Authorization: `Bearer ${token}` }),
		...(method === 'PUT' && {
			'X-Whiteboard-Auth': generateSharedToken(roomId),
			'X-Whiteboard-User': getLastEditedUser(roomId),
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

export const getRoomDataFromFile = async (roomID, jwtToken) => {
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const options = fetchOptions('GET', jwtToken)
	const result = await fetchData(url, options)
	console.log(result)
	return result?.data.elements
}

export const saveRoomDataToFile = async (roomID) => {
	console.log(`[${roomID}] Saving room data to file: ${roomID} with:`)
	const url = `${NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
	const body = { data: { elements: roomDataStore[roomID] } }
	const options = fetchOptions('PUT', null, body, roomID)
	console.log(options)
	await fetchData(url, options)
}

export const handleEmptyRoom = async (roomID) => {
	if (roomDataStore[roomID]) {
		await saveRoomDataToFile(roomID)
		console.log('Removing data for room', roomID)
		delete roomDataStore[roomID]
		lastEditedUser.delete(roomID)
	}
}

export const saveAllRoomsData = () =>
	Promise.all(Object.entries(roomDataStore).map(([roomId, roomData]) =>
		saveRoomDataToFile(roomId, roomData)))

export const removeAllRoomData = () => {
	Object.keys(roomDataStore).forEach(key => delete roomDataStore[key])
	roomUsers.clear()
}

export const addUserToRoom = (roomId, userId) => {
	if (!roomUsers.has(roomId)) {
		roomUsers.set(roomId, new Set())
	}
	roomUsers.get(roomId).add(userId)
}

export const removeUserFromRoom = (roomId, userId) => {
	const room = roomUsers.get(roomId)
	if (room) {
		room.delete(userId)
		if (room.size === 0) {
			roomUsers.delete(roomId)
		}
	}
}

export const updateLastEditedUser = (roomId, userId) => {
	lastEditedUser.set(roomId, userId)
}

export const getLastEditedUser = (roomId) =>
	lastEditedUser.get(roomId) || (roomUsers.has(roomId) ? Array.from(roomUsers.get(roomId)).pop() : null)
