/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Room from './Room.js'

export default class RoomDataManager {

	constructor(storageManager, apiService) {
		this.storageManager = storageManager
		this.apiService = apiService
	}

	async syncRoomData(roomId, data, users, lastEditedUser, jwtToken) {
		console.log(`[${roomId}] Syncing room data`)

		let room = await this.storageManager.get(roomId)

		if (!room) {
			room = new Room(roomId)
			await this.storageManager.set(roomId, room)
		}

		if (!data && !room.data) {
			data = await this.fetchRoomDataFromServer(roomId, jwtToken)
		}

		const files = data?.files
		const elements = data?.elements ?? data
		if (elements) room.setData(elements)
		if (lastEditedUser) room.updateLastEditedUser(lastEditedUser)
		if (users) room.setUsers(users)
		if (files) room.setFiles(files)

		await this.storageManager.set(roomId, room)

		console.log(`[${roomId}] Room data synced. Users: ${room.users.size}, Last edited by: ${room.lastEditedUser}, files: ${Object.keys(room.files).length}`)

		if (room.isEmpty()) {
			await this.storageManager.delete(roomId)
			console.log(`[${roomId}] Room is empty, removed from cache`)
			return null
		}

		return room
	}

	async fetchRoomDataFromServer(roomId, jwtToken) {
		console.log(`[${roomId}] No data provided or existing, fetching from server...`)
		try {
			const result = await this.apiService.getRoomDataFromServer(roomId, jwtToken)
			console.log(`[${roomId}] Fetched data from server: \n`, result)
			return result?.data || { elements: [], files: {} }
		} catch (error) {
			console.error(`[${roomId}] Failed to fetch data from server:`, error)
			return { elements: [], files: {} }
		}
	}

	async removeAllRoomData() {
		await this.storageManager.clear()
	}

}
