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

	/**
	 * Split a configured Redis URL into the node URLs it holds.
	 *
	 * A comma is legal inside a password, so the value only counts as a list of
	 * nodes when it has more than one part and every part on its own is a URL
	 * with a scheme and a host.
	 *
	 * @param {string} url the configured Redis URL
	 * @return {string[]} the node URLs, or the value unchanged as a single entry
	 */
	static splitRedisUrls(url) {
		const parts = url
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0)

		if (parts.length < 2) {
			return [url]
		}

		const everyPartIsAUrl = parts.every((part) => {
			try {
				const parsed = new URL(part)
				return parsed.protocol !== '' && parsed.host !== ''
			} catch {
				return false
			}
		})

		return everyPartIsAUrl ? parts : [url]
	}

	/**
	 * Strip the credentials from one Redis URL.
	 *
	 * @param {string} url one Redis URL
	 * @return {string} the same URL with its credentials replaced
	 */
	static redactOneRedisUrl(url) {
		try {
			const parsed = new URL(url)
			if (parsed.password) {
				parsed.password = '***'
			}
			if (parsed.username) {
				parsed.username = '***'
			}
			return parsed.toString()
		} catch {
			// not a parsable URL: log nothing rather than risk leaking a secret
			return '<unparsable REDIS_URL>'
		}
	}

	/**
	 * Strip credentials from a configured Redis URL so it can be logged safely.
	 *
	 * @param {string} url the configured Redis URL, one node or a list of them
	 * @return {string} the same value with every credential replaced
	 */
	static redactRedisUrl(url) {
		return RedisAdapter.splitRedisUrls(url)
			.map((part) => RedisAdapter.redactOneRedisUrl(part))
			.join(',')
	}

	/**
	 * Parse the configured Redis URL.
	 *
	 * `new URL()` puts the value it was given on the error it throws, and that
	 * error is logged when the server fails to start, so a malformed URL would
	 * print the password it holds. Raise a message that carries nothing from
	 * the configured value instead.
	 *
	 * @param {string} url the configured Redis URL
	 * @return {URL} the parsed URL
	 * @throws {Error} if the value is not a valid URL
	 */
	static parseRedisUrl(url) {
		try {
			return new URL(url)
		} catch {
			throw new Error('REDIS_URL is not a valid URL')
		}
	}

	static createRedisClient() {
		console.log(`Creating Redis client with URL: ${RedisAdapter.redactRedisUrl(Config.REDIS_URL)}`)

		const redisUrl = RedisAdapter.parseRedisUrl(Config.REDIS_URL)

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
