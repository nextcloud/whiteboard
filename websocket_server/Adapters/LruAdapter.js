/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { LRUCache } from 'lru-cache'
import StorageAdapter from './StorageAdapter.js'

export default class LruAdapter extends StorageAdapter {

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

	async set(key, value, options = {}) {
		const setOptions = {}
		if (options.ttl) {
			setOptions.ttl = options.ttl
		}
		this.cache.set(key, value, setOptions)
	}

	async delete(key) {
		this.cache.delete(key)
	}

	async clear() {
		this.cache.clear()
	}

}
