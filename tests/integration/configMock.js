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
	// WebSocket compression setting
	COMPRESSION_ENABLED: true,
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
	}

	const mockConfig = {
		...mockValues,
		...computedProperties,
	}

	return mockConfig
}
