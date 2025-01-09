/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'

export default class GeneralRedisStrategy extends StorageStrategy {

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
			console.error(`Error getting data for key ${key}:`, error)
			return null
		}
	}

	async set(key, value) {
		try {
			const serializedData = JSON.stringify(value)
			if (this.ttl) {
				await this.client.set(`${this.prefix}${key}`, serializedData, {
					EX: this.ttl,
				})
			} else {
				await this.client.set(`${this.prefix}${key}`, serializedData)
			}
		} catch (error) {
			console.error(`Error setting data for key ${key}:`, error)
		}
	}

	async delete(key) {
		try {
			await this.client.del(`${this.prefix}${key}`)
		} catch (error) {
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
			console.error('Error clearing general data:', error)
		}
	}

	getRooms() {
		throw new Error('Method not implemented.')
	}

}
