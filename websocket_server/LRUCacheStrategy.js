/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import { LRUCache } from 'lru-cache'
import Room from './Room.js'

export default class LRUCacheStrategy extends StorageStrategy {

	constructor(apiService, options = { maxRooms: 1000, roomDataMaxAge: 30 * 60 * 1000 }) {
		super()
		this.apiService = apiService
		this.cache = new LRUCache({
			max: options.maxRooms,
			ttl: options.roomDataMaxAge,
			ttlAutopurge: true,
			dispose: async (value, key) => {
				console.log(`[${key}] Disposing room`)

				if (value?.data && value?.lastEditedUser) {
					try {
						await this.apiService.saveRoomDataToServer(
							key,
							value.data,
							value.lastEditedUser,
							value.files,
						)
					} catch (error) {
						console.error(`Failed to save room ${key} data:`, error)
					}
				}
			},
		})
	}

	async get(key) {
		return this.cache.get(key)
	}

	async set(key, value) {
		this.cache.set(key, value)
	}

	async delete(key) {
		this.cache.delete(key)
	}

	async clear() {
		this.cache.clear()
	}

	getRooms() {
		const rooms = Array.from(this.cache.values()).filter(
			(room) => room instanceof Room,
		)

		return rooms
	}

}
