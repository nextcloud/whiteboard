const defaultMockValues = {
	IS_TEST_ENV: true,
	BYPASS_SSL_VALIDATION: false,
	USE_TLS: false,
	TLS_KEY_PATH: null,
	TLS_CERT_PATH: null,
	STORAGE_STRATEGY: 'lru',
	REDIS_URL: null,
	FORCE_CLOSE_TIMEOUT: 60 * 1000,
	METRICS_TOKEN: null,
	JWT_SECRET_KEY: null,
	BACKUP_DIR: './backup',
	ROOM_CLEANUP_INTERVAL: 1000,
	LOCK_TIMEOUT: 1000,
	LOCK_RETRY_INTERVAL: 1000,
	MAX_BACKUPS_PER_ROOM: 10,
	ROOM_MAX_AGE: 1000,
	MAX_ROOMS_IN_STORAGE: 1000,
}

export function createConfigMock(customValues = {}) {
	const mockValues = { ...defaultMockValues, ...customValues }

	const computedProperties = {
		get JWT_SECRET_KEY() {
			return mockValues.JWT_SECRET_KEY
		},
		get NEXTCLOUD_WEBSOCKET_URL() {
			return mockValues.NEXTCLOUD_WEBSOCKET_URL
		},
		get NEXTCLOUD_URL() {
			return mockValues.NEXTCLOUD_URL
		},
	}

	const mockConfig = {
		...mockValues,
		...computedProperties,
	}

	return mockConfig
}
