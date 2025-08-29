/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

/**
 * Centralized logging utility for Nextcloud Whiteboard
 * Only logs in development mode to avoid performance impact and noise in production
 */

const isDevelopment = process.env.NODE_ENV === 'development' || import.meta.env?.DEV === true

type LogArgs = unknown[]

const logger = {
	/**
	 * Log debug information - only in development
	 * @param {unknown[]} args - Arguments to log
	 */
	debug: (...args: LogArgs) => {
		if (isDevelopment) {
			console.log(...args)
		}
	},

	/**
	 * Log warnings - always enabled as they indicate potential issues
	 * @param {unknown[]} args - Arguments to log
	 */
	warn: (...args: LogArgs) => {
		console.warn(...args)
	},

	/**
	 * Log errors - always enabled as they need to be tracked
	 * @param {unknown[]} args - Arguments to log
	 */
	error: (...args: LogArgs) => {
		console.error(...args)
	},

	/**
	 * Log info - only in development
	 * @param {unknown[]} args - Arguments to log
	 */
	info: (...args: LogArgs) => {
		if (isDevelopment) {
			console.info(...args)
		}
	},

	/**
	 * Silent no-op function for completely removing logs
	 */
	noop: () => {},
}

export default logger
