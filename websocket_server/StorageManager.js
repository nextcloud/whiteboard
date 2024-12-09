/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'
import LRUCacheStrategy from './LRUCacheStrategy.js'
import RedisStrategy from './RedisStrategy.js'
import InMemoryStrategy from './InMemoryStrategy.js'
import GeneralLRUStrategy from './GeneralLRUStrategy.js'
import GeneralRedisStrategy from './GeneralRedisStrategy.js'

export default class StorageManager {

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

	static create(strategyType = 'lru', redisClient = null, apiService = null, options = {}) {
		let strategy

		switch (strategyType) {
		case 'lru':
			strategy = new LRUCacheStrategy(apiService)
			break
		case 'redis':
			strategy = new RedisStrategy(redisClient, apiService)
			break
		case 'general-lru':
			strategy = new GeneralLRUStrategy(options)
			break
		case 'general-redis':
			strategy = new GeneralRedisStrategy(redisClient, options)
			break
		case 'in-mem':
			strategy = new InMemoryStrategy()
			break
		default:
			throw new Error('Invalid storage strategy type')
		}

		return new StorageManager(strategy)
	}

}
