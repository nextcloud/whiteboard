/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageAdapter from './StorageAdapter.js'
import { createClient } from 'redis'
import Config from '../Utilities/ConfigUtility.js'

export default class RedisAdapter extends StorageAdapter {

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
			if (RedisAdapter.isClientClosedError(error)) {
				return null
			}
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value, options = {}) {
		try {
			const serializedData = JSON.stringify(value)
			const ttlMs = options.ttl || this.ttl
			if (ttlMs) {
				const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
				await this.client.set(`${this.prefix}${key}`, serializedData, {
					EX: ttlSeconds,
				})
			} else {
				await this.client.set(`${this.prefix}${key}`, serializedData)
			}
		} catch (error) {
			if (RedisAdapter.isClientClosedError(error)) {
				return
			}
			console.error(`Error setting data for key ${key}:`, error)
		}
	}

	async delete(key) {
		try {
			await this.client.del(`${this.prefix}${key}`)
		} catch (error) {
			if (RedisAdapter.isClientClosedError(error)) {
				return
			}
			console.error(`Error deleting key ${key}:`, error)
		}
	}

	async clear() {
		try {
			const batchSize = 100
			let keys = []
			for await (const key of this.client.scanIterator({ MATCH: `${this.prefix}*`, COUNT: batchSize })) {
				keys.push(key)
				if (keys.length >= batchSize) {
					await this.client.del(keys)
					keys = []
				}
			}
			if (keys.length > 0) {
				await this.client.del(keys)
			}
		} catch (error) {
			if (RedisAdapter.isClientClosedError(error)) {
				return
			}
			console.error('Error clearing general data:', error)
		}
	}

}
