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

	static getOriginFromUrl(url) {
		try {
			return new URL(url).origin
		} catch (error) {
			console.error('Invalid URL:', url)
			return null
		}
	}

	/**
	 * Logs operation details
	 * @param {string} context - Context identifier
	 * @param {string} message - Log message
	 * @param {object} [data] - Additional data to log
	 */
	static logOperation(context, message, data = {}) {
		console.log(`[${context}] ${message}:`, data)
	}

	/**
	 * Logs error details
	 * @param {string} context - Context identifier
	 * @param {string} message - Error message
	 * @param {Error} error - Error object
	 */
	static logError(context, message, error) {
		console.error(`[${context}] ${message}:`, error)
	}

}
