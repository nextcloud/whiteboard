const defaultMockValues = {
	IS_TEST_ENV: true,
	USE_TLS: false,
	TLS_KEY_PATH: null,
	TLS_CERT_PATH: null,
	STORAGE_STRATEGY: 'lru',
	REDIS_URL: null,
	FORCE_CLOSE_TIMEOUT: 60 * 1000,
	METRICS_TOKEN: null,
	JWT_SECRET_KEY: null,
	MAX_UPLOAD_FILE_SIZE: 2e6,
	PORT: '3002',
	HOST: '0.0.0.0',
	NEXTCLOUD_URL: 'http://localhost:3002',
	CACHED_TOKEN_TTL: 10 * 60 * 1000,
	// WebSocket compression setting
	COMPRESSION_ENABLED: true,
	SESSION_TTL: 6 * 60 * 60 * 1000,
	NEXTCLOUD_UPLOAD_ENABLED: false,
	CLEANUP_LOCAL_RECORDINGS: false,
	RECORDINGS_DIR: null,
}

export function createConfigMock(customValues = {}) {
	const mockValues = { ...defaultMockValues, ...customValues }

	const computedProperties = {
		get JWT_SECRET_KEY() {
			return mockValues.JWT_SECRET_KEY
		},
		get NEXTCLOUD_URL() {
			return mockValues.NEXTCLOUD_URL
		},
		get CORS_ORIGINS() {
			try {
				const fullUrl = new URL(mockValues.NEXTCLOUD_URL)
				const baseOrigin = `${fullUrl.protocol}//${fullUrl.host}`
				const origins = [mockValues.NEXTCLOUD_URL]

				if (baseOrigin !== mockValues.NEXTCLOUD_URL) {
					origins.push(baseOrigin)
				}
				return origins
			} catch {
				return [mockValues.NEXTCLOUD_URL]
			}
		},
	}

	const mockConfig = {
		...mockValues,
		...computedProperties,
	}

	return mockConfig
}
