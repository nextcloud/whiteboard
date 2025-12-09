/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class DistributedState {

	constructor({ redisClient = null, prefix = 'state_', defaultTtlMs = null } = {}) {
		this.redisClient = redisClient
		this.prefix = prefix
		this.defaultTtlMs = defaultTtlMs
		this.memoryStore = new Map()
		this.memoryHashes = new Map()
	}

	shouldUseRedis() {
		return !!this.redisClient
	}

	#fullKey(key) {
		return `${this.prefix}${key}`
	}

	#expiresAt(ttlMs) {
		if (!ttlMs) return null
		return Date.now() + ttlMs
	}

	#ttlSeconds(ttlMs) {
		if (!ttlMs) return null
		return Math.max(1, Math.ceil(ttlMs / 1000))
	}

	#isExpired(expiresAt) {
		return expiresAt !== null && Date.now() >= expiresAt
	}

	#stringify(value) {
		return JSON.stringify(value)
	}

	#parse(value) {
		try {
			return JSON.parse(value)
		} catch (e) {
			return null
		}
	}

	#matchesPattern(key, pattern) {
		if (!pattern || pattern === '*') {
			return true
		}
		const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
		const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
		return regex.test(key)
	}

	async listValueKeys(matchPattern = '*') {
		if (this.shouldUseRedis()) {
			const keys = []
			const fullMatch = this.#fullKey(matchPattern)
			for await (const key of this.redisClient.scanIterator({ MATCH: fullMatch })) {
				keys.push(key.slice(this.prefix.length))
			}
			return keys
		}

		return Array.from(this.memoryStore.keys())
			.map((key) => key.slice(this.prefix.length))
			.filter((key) => this.#matchesPattern(key, matchPattern))
	}

	async listHashKeys(matchPattern = '*') {
		if (this.shouldUseRedis()) {
			const keys = []
			const fullMatch = this.#fullKey(matchPattern)
			for await (const key of this.redisClient.scanIterator({ MATCH: fullMatch })) {
				keys.push(key.slice(this.prefix.length))
			}
			return keys
		}

		return Array.from(this.memoryHashes.keys())
			.map((key) => key.slice(this.prefix.length))
			.filter((key) => this.#matchesPattern(key, matchPattern))
	}

	async getValue(key, { isStale } = {}) {
		const fullKey = this.#fullKey(key)

		if (this.shouldUseRedis()) {
			try {
				const raw = await this.redisClient.get(fullKey)
				if (!raw) return null
				const value = this.#parse(raw)
				if (isStale && value && await isStale(value)) {
					await this.redisClient.del(fullKey)
					return null
				}
				return value
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return null
				}
				throw error
			}
		}

		const entry = this.memoryStore.get(fullKey)
		if (!entry || this.#isExpired(entry.expiresAt)) {
			this.memoryStore.delete(fullKey)
			return null
		}
		if (isStale && entry.value && await isStale(entry.value)) {
			this.memoryStore.delete(fullKey)
			return null
		}
		return entry.value
	}

	async setValue(key, value, { ttlMs } = {}) {
		const fullKey = this.#fullKey(key)
		const ttlToUse = ttlMs || this.defaultTtlMs

		if (this.shouldUseRedis()) {
			try {
				const serialized = this.#stringify(value)
				const ttlSeconds = this.#ttlSeconds(ttlToUse)
				if (ttlSeconds) {
					await this.redisClient.set(fullKey, serialized, { EX: ttlSeconds })
				} else {
					await this.redisClient.set(fullKey, serialized)
				}
				return
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return
				}
				throw error
			}
		}

		this.memoryStore.set(fullKey, {
			value,
			expiresAt: this.#expiresAt(ttlToUse),
		})
	}

	async deleteValue(key) {
		const fullKey = this.#fullKey(key)

		if (this.shouldUseRedis()) {
			try {
				await this.redisClient.del(fullKey)
				return
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return
				}
				throw error
			}
		}

		this.memoryStore.delete(fullKey)
	}

	async getHash(key, { isStale } = {}) {
		const fullKey = this.#fullKey(key)

		if (this.shouldUseRedis()) {
			try {
				const raw = await this.redisClient.hGetAll(fullKey)
				const parsed = {}
				const staleFields = []

				for (const [field, value] of Object.entries(raw)) {
					const parsedValue = this.#parse(value)
					if (isStale && parsedValue && await isStale(parsedValue, field)) {
						staleFields.push(field)
						continue
					}
					if (parsedValue !== null) {
						parsed[field] = parsedValue
					}
				}

				if (staleFields.length > 0) {
					await this.redisClient.hDel(fullKey, staleFields)
				}

				return parsed
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return {}
				}
				throw error
			}
		}

		const entry = this.memoryHashes.get(fullKey)
		if (!entry || this.#isExpired(entry.expiresAt)) {
			this.memoryHashes.delete(fullKey)
			return {}
		}

		const result = {}
		const staleFields = []
		for (const [field, value] of entry.map.entries()) {
			if (isStale && value && await isStale(value, field)) {
				staleFields.push(field)
				continue
			}
			result[field] = value
		}
		staleFields.forEach(field => entry.map.delete(field))
		return result
	}

	async setHash(key, entries, { ttlMs } = {}) {
		const fullKey = this.#fullKey(key)
		const ttlToUse = ttlMs || this.defaultTtlMs

		if (this.shouldUseRedis()) {
			try {
				const serialized = {}
				for (const [field, value] of Object.entries(entries || {})) {
					serialized[field] = this.#stringify(value)
				}
				if (Object.keys(serialized).length > 0) {
					await this.redisClient.hSet(fullKey, serialized)
					const ttlSeconds = this.#ttlSeconds(ttlToUse)
					if (ttlSeconds) {
						await this.redisClient.expire(fullKey, ttlSeconds)
					}
				} else {
					await this.redisClient.del(fullKey)
				}
				return
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return
				}
				throw error
			}
		}

		if (!entries || Object.keys(entries).length === 0) {
			this.memoryHashes.delete(fullKey)
			return
		}
		const map = new Map()
		for (const [field, value] of Object.entries(entries)) {
			map.set(field, value)
		}
		this.memoryHashes.set(fullKey, {
			map,
			expiresAt: this.#expiresAt(ttlToUse),
		})
	}

	async setHashEntry(key, field, value, { ttlMs } = {}) {
		const fullKey = this.#fullKey(key)
		const ttlToUse = ttlMs || this.defaultTtlMs

		if (this.shouldUseRedis()) {
			try {
				await this.redisClient.hSet(fullKey, field, this.#stringify(value))
				const ttlSeconds = this.#ttlSeconds(ttlToUse)
				if (ttlSeconds) {
					await this.redisClient.expire(fullKey, ttlSeconds)
				}
				return
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return
				}
				throw error
			}
		}

		const entry = this.memoryHashes.get(fullKey) || {
			map: new Map(),
			expiresAt: null,
		}
		entry.map.set(field, value)
		entry.expiresAt = this.#expiresAt(ttlToUse)
		this.memoryHashes.set(fullKey, entry)
	}

	async deleteHashEntry(key, field) {
		const fullKey = this.#fullKey(key)

		if (this.shouldUseRedis()) {
			try {
				const removed = await this.redisClient.hDel(fullKey, field)
				const remaining = await this.redisClient.hLen(fullKey)
				if (remaining === 0) {
					await this.redisClient.del(fullKey)
				}
				return removed > 0
			} catch (error) {
				if (this.#isClientClosedError(error)) {
					return false
				}
				throw error
			}
		}

		const entry = this.memoryHashes.get(fullKey)
		if (!entry) return false
		const removed = entry.map.delete(field)
		if (entry.map.size === 0) {
			this.memoryHashes.delete(fullKey)
		}
		return removed
	}

	#isClientClosedError(error) {
		return error?.name === 'ClientClosedError' || error?.message?.includes('The client is closed')
	}

}
