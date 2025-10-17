/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import dotenv from 'dotenv'
import crypto from 'crypto'
import fs from 'fs'
import {
	DEFAULT_NEXTCLOUD_URL,
	DEFAULT_PORT,
	DEFAULT_STORAGE_STRATEGY,
	DEFAULT_FORCE_CLOSE_TIMEOUT,
	DEFAULT_REDIS_URL,
	DEFAULT_CACHED_TOKEN_TTL,
	DEFAULT_COMPRESSION_ENABLED,
} from './Constants.js'
import Utils from './Utils.js'

dotenv.config()

const Config = {
	IS_TEST_ENV: process.env.NODE_ENV === 'test',

	PORT: process.env.PORT || DEFAULT_PORT,

	USE_TLS: Utils.parseBooleanFromEnv(process.env.TLS),

	TLS_KEY_PATH: process.env.TLS_KEY || null,

	TLS_CERT_PATH: process.env.TLS_CERT || null,

	STORAGE_STRATEGY: process.env.STORAGE_STRATEGY || DEFAULT_STORAGE_STRATEGY,

	REDIS_URL: process.env.REDIS_URL || DEFAULT_REDIS_URL,

	FORCE_CLOSE_TIMEOUT: process.env.FORCE_CLOSE_TIMEOUT || DEFAULT_FORCE_CLOSE_TIMEOUT,

	METRICS_TOKEN: process.env.METRICS_TOKEN || null,

	MAX_UPLOAD_FILE_SIZE: process.env.MAX_UPLOAD_FILE_SIZE * (1e6) || 2e6,

	CACHED_TOKEN_TTL: process.env.CACHED_TOKEN_TTL || DEFAULT_CACHED_TOKEN_TTL,

	// WebSocket compression setting
	COMPRESSION_ENABLED: process.env.COMPRESSION_ENABLED !== undefined
		? Utils.parseBooleanFromEnv(process.env.COMPRESSION_ENABLED)
		: DEFAULT_COMPRESSION_ENABLED,

	get JWT_SECRET_KEY() {
		if (!process.env.JWT_SECRET_KEY) {
			const newSecret = crypto.randomBytes(32).toString('hex')
			process.env.JWT_SECRET_KEY = newSecret
		}

		return process.env.JWT_SECRET_KEY
	},

	get NEXTCLOUD_URL() {
		return Utils.normalizeUrlPath(process.env.NEXTCLOUD_URL || DEFAULT_NEXTCLOUD_URL)
	},

	get CORS_ORIGINS() {
		const fullUrl = new URL(this.NEXTCLOUD_URL)
		const baseOrigin = `${fullUrl.protocol}//${fullUrl.host}`
		const origins = [this.NEXTCLOUD_URL]

		if (baseOrigin !== this.NEXTCLOUD_URL) {
			origins.push(baseOrigin)
		}

		return origins
	},

	// Recording configuration
	NEXTCLOUD_UPLOAD_ENABLED: Utils.parseBooleanFromEnv(process.env.NEXTCLOUD_UPLOAD_ENABLED),
	CLEANUP_LOCAL_RECORDINGS: Utils.parseBooleanFromEnv(process.env.CLEANUP_LOCAL_RECORDINGS),
	RECORDINGS_DIR: process.env.RECORDINGS_DIR || null,

	// Chrome detection for puppeteer-core
	get CHROME_EXECUTABLE_PATH() {
		// If explicitly set via environment variable, use it
		if (process.env.CHROME_EXECUTABLE_PATH) {
			return process.env.CHROME_EXECUTABLE_PATH
		}

		// Common Chrome/Chromium installation paths by platform
		const platform = process.platform
		const possiblePaths = []

		if (platform === 'darwin') {
			// macOS
			possiblePaths.push(
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				'/Applications/Chromium.app/Contents/MacOS/Chromium',
				'/usr/bin/google-chrome-stable',
				'/usr/bin/chromium-browser',
			)
		} else if (platform === 'linux') {
			// Linux
			possiblePaths.push(
				'/usr/bin/google-chrome-stable',
				'/usr/bin/google-chrome',
				'/usr/bin/chromium-browser',
				'/usr/bin/chromium',
				'/snap/bin/chromium',
				'/opt/google/chrome/chrome',
			)
		} else if (platform === 'win32') {
			// Windows
			possiblePaths.push(
				'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
				'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
				'C:\\Program Files\\Chromium\\Application\\chromium.exe',
				'C:\\Program Files (x86)\\Chromium\\Application\\chromium.exe',
				'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
			)
		}

		// Check each path and return the first one that exists
		for (const chromePath of possiblePaths) {
			if (fs.existsSync(chromePath)) {
				console.log(`[Config] Found Chrome at: ${chromePath}`)
				return chromePath
			}
		}

		// If no Chrome found, return undefined to let puppeteer-core try its own detection
		console.log('[Config] No Chrome found in common paths, letting puppeteer-core auto-detect')
		return undefined
	},
}

export default Config
