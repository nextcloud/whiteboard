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
	 * Ensures a URL has a protocol and no trailing slashes
	 * @param {string} url - URL to normalize
	 * @param {boolean} [useTLS] - Whether to use HTTPS (true) or HTTP (false) when protocol is missing
	 * @return {string} Normalized URL
	 */
	static normalizeUrlPath(url, useTLS = true) {
		if (!url?.trim()) return ''

		try {
			const withProtocol = url.match(/^https?:\/\//)
				? url
				: `${useTLS ? 'https' : 'http'}://${url}`

			const urlObj = new URL(withProtocol)

			if (urlObj.pathname === '/' || urlObj.pathname === '') {
				return urlObj.origin
			}

			return `${urlObj.origin}${urlObj.pathname.replace(/\/+$/, '')}`
		} catch (error) {
			console.error(`Invalid URL: "${url}" - ${error.message}`)
			return url
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
