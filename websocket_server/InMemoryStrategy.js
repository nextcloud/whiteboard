/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import StorageStrategy from './StorageStrategy.js'

export default class InMemoryStrategy extends StorageStrategy {

	constructor() {
		super()
		this.store = new Map()
	}

	async get(key) {
		return this.store.get(key)
	}

	async set(key, value) {
		this.store.set(key, value)
	}

	async delete(key) {
		this.store.delete(key)
	}

	async clear() {
		this.store.clear()
	}

	getRooms() {
		throw new Error('Method not implemented.')
	}

}
