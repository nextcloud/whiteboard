/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class SocketDataManager {

	constructor(storageManager) {
		this.storageManager = storageManager
	}

	async setCachedToken(token, decodedData) {
		await this.storageManager.set(`token:${token}`, decodedData)
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

}
