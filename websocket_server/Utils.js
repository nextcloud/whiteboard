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

}
