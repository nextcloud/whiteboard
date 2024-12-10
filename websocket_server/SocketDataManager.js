/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class SocketDataManager {

	constructor(storageManager) {
		this.storageManager = storageManager
		this.activeTokens = new Set()
	}

	async setCachedToken(token, decodedData) {
		this.activeTokens.add(token)
		await this.storageManager.set(`token:${token}`, decodedData)
	}

	async invalidateToken(token) {
		this.activeTokens.delete(token)
		await this.storageManager.delete(`token:${token}`)
	}

	async getCachedToken(token) {
		return this.storageManager.get(`token:${token}`)
	}

	async setSocketData(socketId, data) {
		await this.storageManager.set(`socket:${socketId}`, data)
	}

	async getSocketData(socketId) {
		return this.storageManager.get(`socket:${socketId}`)
	}

	async deleteSocketData(socketId) {
		await this.storageManager.delete(`socket:${socketId}`)
	}

	async cleanup() {
		const tokens = Array.from(this.activeTokens)
		for (const token of tokens) {
			const data = await this.getCachedToken(token)
			if (!data) {
				this.activeTokens.delete(token)
			}
		}
	}

}
