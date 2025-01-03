/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import { createClient } from 'redis'
import Room from './Room.js'
import Config from './Config.js'

export default class RedisStrategy extends StorageStrategy {

	static createRedisClient() {
		return createClient({
			url: Config.REDIS_URL,
			retry_strategy: (options) => {
				if (options.error?.code === 'ECONNREFUSED') {
					return new Error('The server refused the connection')
				}
				if (options.total_retry_time > 1000 * 60 * 60) {
					return new Error('Retry time exhausted')
				}
				if (options.attempt > 10) {
					return undefined
				}
				return Math.min(options.attempt * 100, 3000)
			},
		})
	}

	constructor(redisClient, apiService) {
		super()
		this.apiService = apiService
		this.client = redisClient
	}

	async get(key) {
		try {
			const data = await this.client.get(key)
			return data ? this.deserialize(data) : null
		} catch (error) {
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value) {
		try {
			const serializedData = this.serialize(value)
			await this.client.set(key, serializedData, {
				EX: Config.ROOM_MAX_AGE / 1000,
			})
		} catch (error) {
			console.error(`Error setting data for key ${key}:`, error)
		}
	}

	async delete(key) {
		try {
			const room = await this.get(key)
			if (room?.data && room?.lastEditedUser) {
				await this.apiService.saveRoomDataToServer(
					key,
					room.data,
					room.lastEditedUser,
					room.files,
				)
			}
			await this.client.del(key)
		} catch (error) {
			console.error(`Error deleting key ${key}:`, error)
		}
	}

	async clear() {
		try {
			const rooms = await this.getRooms()
			for (const [key] of rooms) {
				await this.delete(key)
			}
		} catch (error) {
			console.error('Error clearing Redis database:', error)
		}
	}

	async getRooms() {
		try {
			const keys = await this.client.keys('*')
			const rooms = new Map()

			for (const key of keys) {
				if (key.startsWith('token_') || key.startsWith('socket_')) {
					continue
				}
				const room = await this.get(key)
				if (room) {
					rooms.set(key, room)
				}
			}
			return rooms
		} catch (error) {
			console.error('Error getting rooms:', error)
			return new Map()
		}
	}

	serialize(value) {
		return JSON.stringify(
			value instanceof Room ? value.toJSON() : value,
		)
	}

	deserialize(data) {
		const parsedData = JSON.parse(data)
		return parsedData.id && parsedData.users
			? Room.fromJSON(parsedData)
			: parsedData
	}

}
