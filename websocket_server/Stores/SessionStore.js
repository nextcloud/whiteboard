/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class SessionStore {

	constructor(storage) {
		this.storage = storage
	}

	async getSocketData(socketId) {
		return this.storage.get(socketId)
	}

	async setSocketData(socketId, data) {
		await this.storage.set(socketId, data)
	}

	async deleteSocketData(socketId) {
		await this.storage.delete(socketId)
	}

	async setConnectedAt(socketId, timestamp) {
		await this.storage.set(`${socketId}:connected_at`, timestamp)
	}

	async clearConnectedAt(socketId) {
		await this.storage.delete(`${socketId}:connected_at`)
	}

	async setFollowing(socketId, userId) {
		await this.storage.set(`${socketId}:following`, userId)
	}

	async clearFollowing(socketId) {
		await this.storage.delete(`${socketId}:following`)
	}

	async clearSocketMeta(socketId) {
		await Promise.all([
			this.deleteSocketData(socketId),
			this.clearConnectedAt(socketId),
			this.clearFollowing(socketId),
		])
	}

	async getUser(socketId) {
		const data = await this.getSocketData(socketId)
		return data ? data.user : null
	}

	async isReadOnly(socketId) {
		const data = await this.getSocketData(socketId)
		return data ? !!data.isFileReadOnly : false
	}

}
