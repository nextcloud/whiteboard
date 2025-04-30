/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import dotenv from 'dotenv'
import crypto from 'crypto'
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

	get NEXTCLOUD_WEBSOCKET_URL() {
		return Utils.getOriginFromUrl(process.env.NEXTCLOUD_URL || DEFAULT_NEXTCLOUD_URL)
	},

	get NEXTCLOUD_URL() {
		return this.NEXTCLOUD_WEBSOCKET_URL
	},
}

export default Config
