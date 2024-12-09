/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export default class SocketDataManager {

	/**
	 * @typedef {object} UserData
	 * @property {string} id - User identifier
	 * @property {string} name - User display name
	 */

	/**
	 * @typedef {object} DecodedTokenData
	 * @property {string} userid - User identifier
	 * @property {number} fileId - File identifier
	 * @property {boolean} isFileReadOnly - Whether the file is read-only
	 * @property {UserData} user - User information
	 * @property {number} iat - Token issued at timestamp
	 * @property {number} exp - Token expiration timestamp
	 * @property {string} [jwtToken] - Original JWT token string
	 */

	/**
	 * @param {object} storageManager - Storage manager instance for data persistence
	 */
	constructor(storageManager) {
		this.storageManager = storageManager
	}

	/**
	 * Caches decoded token data
	 * @param {string} token - JWT token
	 * @param {DecodedTokenData} decodedData - Decoded token payload
	 */
	async setCachedToken(token, decodedData) {
		await this.storageManager.set(`token:${token}`, decodedData)
	}

	/**
	 * Removes token from cache
	 * @param {string} token - JWT token to invalidate
	 */
	async invalidateToken(token) {
		await this.storageManager.delete(`token:${token}`)
	}

	/**
	 * Retrieves cached token data
	 * @param {string} token - JWT token
	 * @return {Promise<object | null>} Decoded token data if exists
	 */
	async getCachedToken(token) {
		return this.storageManager.get(`token:${token}`)
	}

	/**
	 * Stores socket session data
	 * @param {string} socketId - Socket identifier
	 * @param {object} data - Socket session data
	 */
	async setSocketData(socketId, data) {
		await this.storageManager.set(`socket:${socketId}`, data)
	}

	/**
	 * Retrieves socket session data
	 * @param {string} socketId - Socket identifier
	 * @return {Promise<object | null>} Socket session data if exists
	 */
	async getSocketData(socketId) {
		return this.storageManager.get(`socket:${socketId}`)
	}

	/**
	 * Removes socket session data
	 * @param {string} socketId - Socket identifier
	 */
	async deleteSocketData(socketId) {
		await this.storageManager.delete(`socket:${socketId}`)
	}

}
