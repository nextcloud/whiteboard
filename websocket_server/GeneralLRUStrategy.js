/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { LRUCache } from 'lru-cache'
import StorageStrategy from './StorageStrategy.js'

export default class GeneralLRUStrategy extends StorageStrategy {

	constructor(options = {}) {
		const { max = 1000, ttl = 1000 * 60 * 60 * 24, ttlAutopurge = true } = options
		super()
		this.cache = new LRUCache({
			max,
			ttl,
			ttlAutopurge,
		})
	}

	async get(key) {
		return this.cache.get(key)
	}

	async set(key, value) {
		this.cache.set(key, value)
	}

	async delete(key) {
		this.cache.delete(key)
	}

	async clear() {
		this.cache.clear()
	}

	getRooms() {
		throw new Error('Method not implemented.')
	}

}
