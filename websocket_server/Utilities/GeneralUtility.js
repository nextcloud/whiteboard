/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

export default class GeneralUtility {

	static convertStringToArrayBuffer(string) {
		return new TextEncoder().encode(string)
	}

	static convertArrayBufferToString(arrayBuffer) {
		return new TextDecoder().decode(arrayBuffer)
	}

	static parseBooleanFromEnv(value) {
		return value === 'true'
	}

	static normalizeUrlPath(url) {
		try {
			// If URL already has protocol, use it as-is but remove trailing slashes
			if (url.match(/^https?:\/\//)) {
				const urlObj = new URL(url)
				if (urlObj.pathname === '/' || urlObj.pathname === '') {
					return urlObj.origin
				}
				return `${urlObj.origin}${urlObj.pathname.replace(/\/+$/, '')}`
			}

			// If no protocol, just return the original URL to avoid rewriting
			return url
		} catch (error) {
			console.error('Invalid URL:', url)
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
