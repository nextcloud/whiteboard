/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import dotenv from 'dotenv'
import { LRUCache } from 'lru-cache'
import { createClient } from 'redis'

dotenv.config()

export class Room {

	constructor(id, data = null, users = new Set(), lastEditedUser = null) {
		this.id = id
		this.data = data
		this.users = new Set(users)
		this.lastEditedUser = lastEditedUser
	}

	setUsers(users) {
		this.users = new Set(users)
	}

	updateLastEditedUser(userId) {
		this.lastEditedUser = userId
	}

	setData(data) {
		this.data = data
	}

	isEmpty() {
		return this.users.size === 0
	}

	toJSON() {
		return {
			id: this.id,
			data: this.data,
			users: Array.from(this.users),
			lastEditedUser: this.lastEditedUser,
			lastActivity: this.lastActivity,
		}
	}

	static fromJSON(json) {
		return new Room(json.id, json.data, new Set(json.users), json.lastEditedUser)
	}

}

export class StorageStrategy {

	async get(key) { throw new Error('Method not implemented.') }
	async set(key, value) { throw new Error('Method not implemented.') }
	async delete(key) { throw new Error('Method not implemented.') }
	async clear() { throw new Error('Method not implemented.') }
	getRooms() { throw new Error('Method not implemented.') }

}

export class LRUCacheStrategy extends StorageStrategy {

	constructor(apiService) {
		super()
		this.apiService = apiService
		this.cache = new LRUCache({
			ttl: 30 * 60 * 1000,
			ttlAutopurge: true,
			dispose: async (value, key) => {
				console.log('Disposing room', key)
				if (value?.data && value?.lastEditedUser) {
					try {
						await this.apiService.saveRoomDataToServer(key, value.data, value.lastEditedUser)
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
		return this.cache
	}

}

export class RedisStrategy extends StorageStrategy {

	constructor(apiService) {
		super()
		this.apiService = apiService
		this.client = createClient({
			url: process.env.REDIS_URL || 'redis://localhost:6379',
		})
		this.client.on('error', (err) => console.error('Redis Client Error', err))
		this.client.connect()
	}

	async get(key) {
		const data = await this.client.get(key)
		return data ? Room.fromJSON(JSON.parse(data)) : null
	}

	async set(key, value) {
		await this.client.set(key, JSON.stringify(value.toJSON()), {
			EX: 30 * 60,
		})
	}

	async delete(key) {
		const room = await this.get(key)
		if (room?.data && room?.lastEditedUser) {
			try {
				await this.apiService.saveRoomDataToServer(key, room.data, room.lastEditedUser)
			} catch (error) {
				console.error(`Failed to save room ${key} data:`, error)
			}
		}
		await this.client.del(key)
	}

	async clear() {
		await this.client.flushDb()
	}

	async getRooms() {
		const keys = await this.client.keys('*')
		const rooms = new Map()
		for (const key of keys) {
			const room = await this.get(key)
			if (room) rooms.set(key, room)
		}
		return rooms
	}

}

export class StorageManager {

	constructor(strategy) {
		this.setStrategy(strategy)
	}

	setStrategy(strategy) {
		if (strategy instanceof StorageStrategy) {
			this.strategy = strategy
		} else {
			throw new Error('Invalid strategy')
		}
	}

	async get(key) {
		return this.strategy.get(key)
	}

	async set(key, value) {
		await this.strategy.set(key, value)
	}

	async delete(key) {
		await this.strategy.delete(key)
	}

	async clear() {
		await this.strategy.clear()
	}

	getRooms() {
		return this.strategy.getRooms()
	}

}

export class RoomDataManager {

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
			console.log(`[${roomId}] No data provided or existing, fetching from server...`)
			try {
				const result = await this.apiService.getRoomDataFromServer(roomId, jwtToken)
				data = result?.data?.elements || { elements: [] }
			} catch (error) {
				console.error(`[${roomId}] Failed to fetch data from server:`, error)
				data = { elements: [] }
			}
		}

		if (data) room.setData(data)
		if (lastEditedUser) room.updateLastEditedUser(lastEditedUser)
		if (users) room.setUsers(users)

		await this.storageManager.set(roomId, room)

		console.log(`[${roomId}] Room data synced. Users: ${room.users.size}, Last edited by: ${room.lastEditedUser}`)

		if (room.isEmpty()) {
			await this.storageManager.delete(roomId)
			console.log(`[${roomId}] Room is empty, removed from cache`)
			return null
		}

		return room
	}

	async removeAllRoomData() {
		await this.storageManager.clear()
	}

	async saveRoomData(roomId, data, lastEditedUser) {
		return this.apiService.saveRoomDataToServer(roomId, data, lastEditedUser)
	}

}

export function createStorageManager(strategyType, apiService) {
	let strategy
	switch (strategyType) {
	case 'lru':
		strategy = new LRUCacheStrategy(apiService)
		break
	case 'redis':
		strategy = new RedisStrategy(apiService)
		break
	default:
		throw new Error(`Unknown strategy type: ${strategyType}`)
	}
	return new StorageManager(strategy)
}

export function createRoomDataManager(strategyType, apiService) {
	const storageManager = createStorageManager(strategyType, apiService)

	return new RoomDataManager(storageManager, apiService)
}
