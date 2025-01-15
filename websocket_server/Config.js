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
	DEFAULT_ROOM_CLEANUP_INTERVAL,
	DEFAULT_LOCK_TIMEOUT,
	DEFAULT_LOCK_RETRY_INTERVAL,
	DEFAULT_MAX_BACKUPS_PER_ROOM,
	DEFAULT_BACKUP_DIR,
	DEFAULT_ROOM_MAX_AGE,
	DEFAULT_MAX_ROOMS_IN_STORAGE,
	DEFAULT_CACHED_TOKEN_TTL,
} from './Constants.js'
import Utils from './Utils.js'

dotenv.config()

const Config = {
	IS_TEST_ENV: process.env.NODE_ENV === 'test',

	BYPASS_SSL_VALIDATION: Utils.parseBooleanFromEnv(process.env.BYPASS_SSL_VALIDATION),

	PORT: process.env.PORT || DEFAULT_PORT,

	USE_TLS: Utils.parseBooleanFromEnv(process.env.TLS),

	TLS_KEY_PATH: process.env.TLS_KEY || null,

	TLS_CERT_PATH: process.env.TLS_CERT || null,

	STORAGE_STRATEGY: process.env.STORAGE_STRATEGY || DEFAULT_STORAGE_STRATEGY,

	REDIS_URL: process.env.REDIS_URL || DEFAULT_REDIS_URL,

	FORCE_CLOSE_TIMEOUT: process.env.FORCE_CLOSE_TIMEOUT || DEFAULT_FORCE_CLOSE_TIMEOUT,

	METRICS_TOKEN: process.env.METRICS_TOKEN || null,

	BACKUP_DIR: process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR,

	MAX_BACKUPS_PER_ROOM: process.env.MAX_BACKUPS_PER_ROOM || DEFAULT_MAX_BACKUPS_PER_ROOM,

	MAX_UPLOAD_FILE_SIZE: process.env.MAX_UPLOAD_FILE_SIZE * (1e6) || 2e6,

	LOCK_TIMEOUT: process.env.LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT,

	LOCK_RETRY_INTERVAL: process.env.LOCK_RETRY_INTERVAL || DEFAULT_LOCK_RETRY_INTERVAL,

	ROOM_CLEANUP_INTERVAL: process.env.ROOM_CLEANUP_INTERVAL || DEFAULT_ROOM_CLEANUP_INTERVAL,

	ROOM_MAX_AGE: process.env.ROOM_MAX_AGE || DEFAULT_ROOM_MAX_AGE,

	MAX_ROOMS_IN_STORAGE: process.env.MAX_ROOMS_IN_STORAGE || DEFAULT_MAX_ROOMS_IN_STORAGE,

	CACHED_TOKEN_TTL: process.env.CACHED_TOKEN_TTL || DEFAULT_CACHED_TOKEN_TTL,

	get JWT_SECRET_KEY() {
		if (!process.env.JWT_SECRET_KEY) {
			const newSecret = crypto.randomBytes(32).toString('hex')
			process.env.JWT_SECRET_KEY = newSecret
			console.log('Generated new JWT_SECRET_KEY:', newSecret)
		} else {
			console.log('Using existing JWT_SECRET_KEY from environment')
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
