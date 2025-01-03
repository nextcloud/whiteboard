/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const DEFAULT_NEXTCLOUD_URL = 'http://nextcloud.local'

export const DEFAULT_PORT = 3002

export const DEFAULT_STORAGE_STRATEGY = 'lru'

export const DEFAULT_FORCE_CLOSE_TIMEOUT = 60 * 60 * 1000

export const DEFAULT_REDIS_URL = 'redis://localhost:6379'

export const DEFAULT_BACKUP_DIR = './backup'

export const DEFAULT_MAX_BACKUPS_PER_ROOM = 5

export const DEFAULT_LOCK_TIMEOUT = 5000

export const DEFAULT_LOCK_RETRY_INTERVAL = 50

export const DEFAULT_ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000

export const DEFAULT_ROOM_MAX_AGE = 5 * 60 * 1000 // 5 minutes, which will also save the room data to nextcloud

export const DEFAULT_CACHED_TOKEN_TTL = 10 * 60 * 1000

export const DEFAULT_MAX_ROOMS_IN_STORAGE = 1000

export const DEFAULT_EMPTY_ROOM_DATA = Object.freeze({
	elements: [],
	files: {},
})
