/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageAdapter from '../Adapters/StorageAdapter.js'
import LruAdapter from '../Adapters/LruAdapter.js'
import RedisAdapter from '../Adapters/RedisAdapter.js'
import MemoryAdapter from '../Adapters/MemoryAdapter.js'

export default class StorageService {

	constructor(strategy) {
		this.setStrategy(strategy)
	}

	setStrategy(strategy) {
		if (strategy instanceof StorageAdapter) {
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

	static create(strategyType = 'lru', redisClient = null, options = {}) {
		let strategy

		switch (strategyType) {
		case 'lru':
			strategy = new LruAdapter(options)
			break
		case 'redis':
			strategy = new RedisAdapter(redisClient, options)
			break
		case 'in-mem':
			strategy = new MemoryAdapter()
			break
		default:
			throw new Error('Invalid storage strategy type')
		}

		return new StorageService(strategy)
	}

}
