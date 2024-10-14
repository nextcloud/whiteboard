/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import { createClient } from 'redis'
import Room from './Room.js'

export default class RedisStrategy extends StorageStrategy {

	constructor(apiService) {
		super()
		this.apiService = apiService
		this.client = createClient({
			url: process.env.REDIS_URL || 'redis://localhost:6379',
			retry_strategy: (options) => {
				if (options.error && options.error.code === 'ECONNREFUSED') {
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
		this.client.on('error', (err) =>
			console.error('Redis Client Error', err),
		)
		this.connect()
	}

	async connect() {
		try {
			await this.client.connect()
		} catch (error) {
			console.error('Failed to connect to Redis:', error)
			throw error
		}
	}

	async get(key) {
		try {
			const data = await this.client.get(key)
			if (!data) return null
			return this.deserialize(data)
		} catch (error) {
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value) {
		try {
			const serializedData = this.serialize(value)
			await this.client.set(key, serializedData, { EX: 30 * 60 })
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
			await this.client.flushDb()
		} catch (error) {
			console.error('Error clearing Redis database:', error)
		}
	}

	async getRooms() {
		try {
			const keys = await this.client.keys('*')
			const rooms = new Map()
			for (const key of keys) {
				const room = await this.get(key)
				if (room && !key.startsWith('token:') && !key.startsWith('socket:')) rooms.set(key, room)
			}
			return rooms
		} catch (error) {
			console.error('Error getting rooms:', error)
			return new Map()
		}
	}

	serialize(value) {
		return value instanceof Room
			? JSON.stringify(value.toJSON())
			: JSON.stringify(value)
	}

	deserialize(data) {
		const parsedData = JSON.parse(data)
		return parsedData.id && parsedData.users
			? Room.fromJSON(parsedData)
			: parsedData
	}

}
