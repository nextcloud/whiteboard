/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class StorageStrategy {

	async get(key) {
		throw new Error('Method not implemented.')
	}

	async set(key, value) {
		throw new Error('Method not implemented.')
	}

	async delete(key) {
		throw new Error('Method not implemented.')
	}

	async clear() {
		throw new Error('Method not implemented.')
	}

}
