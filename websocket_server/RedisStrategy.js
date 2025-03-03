/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import { createClient } from 'redis'
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
			return data ? JSON.parse(data) : null
		} catch (error) {
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value) {
		try {
			const serializedData = JSON.stringify(value)
			await this.client.set(key, serializedData, {
				EX: Config.ROOM_MAX_AGE / 1000,
			})
		} catch (error) {
			console.error(`Error setting data for key ${key}:`, error)
		}
	}

	async delete(key) {
		try {
			await this.client.del(key)
		} catch (error) {
			console.error(`Error deleting key ${key}:`, error)
		}
	}

	async clear() {
		try {
			const keys = await this.client.keys('*')
			for (const key of keys) {
				await this.delete(key)
			}
		} catch (error) {
			console.error('Error clearing Redis database:', error)
		}
	}

}
