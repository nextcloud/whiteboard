/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

export default class Utils {

	static convertStringToArrayBuffer(string) {
		return new TextEncoder().encode(string).buffer
	}

	static convertArrayBufferToString(arrayBuffer) {
		return new TextDecoder().decode(arrayBuffer)
	}

	static parseBooleanFromEnv(value) {
		return value === 'true'
	}

	/**
	 * Logs operation details
	 * @param {string} roomId - Room identifier
	 * @param {string} message - Log message
	 * @param {object} [data] - Additional data to log
	 */
	static logOperation(roomId, message, data = {}) {
		console.log(`[${roomId}] ${message}:`, data)
	}

	/**
	 * Logs error details
	 * @param {string} roomId - Room identifier
	 * @param {string} message - Error message
	 * @param {Error} error - Error object
	 */
	static logError(roomId, message, error) {
		console.error(`[${roomId}] ${message}:`, error)
	}

}
