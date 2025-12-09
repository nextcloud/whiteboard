/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import { createClient } from 'redis'
import Config from './Config.js'

export default class RedisStrategy extends StorageStrategy {

	static isClientClosedError(error) {
		return error?.name === 'ClientClosedError' || error?.message?.includes('The client is closed')
	}

	static createRedisClient() {
		console.log(`Creating Redis client with URL: ${Config.REDIS_URL}`)

		const redisUrl = new URL(Config.REDIS_URL)

		if (redisUrl.protocol === 'unix:') {
			const db = redisUrl.searchParams.get('db')
			return createClient({
				socket: { path: redisUrl.pathname },
				database: db !== null ? Number(db) : undefined,
			})
		} else {
			return createClient({ url: Config.REDIS_URL })
		}
	}

	constructor(redisClient, options = {}) {
		const { prefix = 'general_', ttl = null } = options
		super()
		this.prefix = prefix
		this.ttl = ttl
		this.client = redisClient
	}

	async get(key) {
		try {
			const data = await this.client.get(`${this.prefix}${key}`)
			if (!data) return null
			return JSON.parse(data)
		} catch (error) {
			if (RedisStrategy.isClientClosedError(error)) {
				return null
			}
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value) {
		try {
			const serializedData = JSON.stringify(value)
			if (this.ttl) {
				const ttlSeconds = Math.max(1, Math.ceil(this.ttl / 1000))
				await this.client.set(`${this.prefix}${key}`, serializedData, {
					EX: ttlSeconds,
				})
			} else {
				await this.client.set(`${this.prefix}${key}`, serializedData)
			}
		} catch (error) {
			if (RedisStrategy.isClientClosedError(error)) {
				return
			}
			console.error(`Error setting data for key ${key}:`, error)
		}
	}

	async delete(key) {
		try {
			await this.client.del(`${this.prefix}${key}`)
		} catch (error) {
			if (RedisStrategy.isClientClosedError(error)) {
				return
			}
			console.error(`Error deleting key ${key}:`, error)
		}
	}

	async clear() {
		try {
			const keys = await this.client.keys(`${this.prefix}*`)
			if (keys.length > 0) {
				await this.client.del(keys)
			}
		} catch (error) {
			if (RedisStrategy.isClientClosedError(error)) {
				return
			}
			console.error('Error clearing general data:', error)
		}
	}

}
