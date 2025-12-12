/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import StorageService from './StorageService.js'
import AppService from './AppService.js'
import SocketService from './SocketService.js'
import Config from '../Utilities/ConfigUtility.js'
import RedisAdapter from '../Adapters/RedisAdapter.js'
import SystemMonitorService from './SystemMonitorService.js'
import PrometheusDataService from './PrometheusDataService.js'

export default class ServerService {

	constructor() {
		this.closing = false

		this.redisClient = Config.STORAGE_STRATEGY === 'redis'
			? RedisAdapter.createRedisClient()
			: null

		if (this.redisClient) {
			this.redisClient.connect().catch(error => {
				console.error('Failed to connect to Redis:', error)
				throw error
			})
		}

		this.socketDataStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageService.create('redis', this.redisClient, { prefix: 'socket_', ttl: Config.SESSION_TTL })
			: StorageService.create('in-mem')

		this.cachedTokenStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageService.create('redis', this.redisClient, { prefix: 'token_', ttl: Config.CACHED_TOKEN_TTL })
			: StorageService.create('lru', null, { ttl: Config.CACHED_TOKEN_TTL })

		// Initialize monitoring components
		this.systemMonitorService = new SystemMonitorService(null, this.cachedTokenStorage)
		this.metricsService = Config.METRICS_TOKEN
			? new PrometheusDataService(this.systemMonitorService)
			: null

		// Initialize app service with both system monitor and metrics service
		this.appService = new AppService(this.systemMonitorService, this.metricsService)

		this.server = this.createConfiguredServer(this.appService.getApp())

		this.socketService = new SocketService(
			this.server,
			this.socketDataStorage,
			this.cachedTokenStorage,
			this.redisClient,
		)

		// Update system monitor with socket service reference
		this.systemMonitorService.socketService = this.socketService

		console.log(`Server initialized with ${Config.STORAGE_STRATEGY} storage strategy`)
		console.log(`Metrics ${this.metricsService ? 'enabled' : 'disabled'}`)
	}

	readTlsCredentials(keyPath, certPath) {
		return {
			key: keyPath ? fs.readFileSync(keyPath) : undefined,
			cert: certPath ? fs.readFileSync(certPath) : undefined,
		}
	}

	createConfiguredServer(app) {
		const serverType = Config.USE_TLS ? https : http
		const serverOptions = Config.USE_TLS ? this.readTlsCredentials(Config.TLS_KEY_PATH, Config.TLS_CERT_PATH) : {}

		return serverType.createServer(serverOptions, app)
	}

	start() {
		return new Promise((resolve, reject) => {
			this.server.listen(Config.PORT, Config.HOST, () => {
				console.log(`Listening on interface ${Config.HOST} port: ${Config.PORT}`)
				resolve()
			})

			this.server.on('error', (error) => {
				console.error('Server error:', error)
				reject(error)
			})

			const handleShutdown = async (signal) => {
				try {
					console.log(`Received ${signal} signal`)
					await this.gracefulShutdown()
					if (!Config.IS_TEST_ENV) {
						process.exit(0)
					}
				} catch (error) {
					console.error('Failed to shutdown gracefully:', error)
					if (!Config.IS_TEST_ENV) {
						process.exit(1)
					}
				}
			}

			process.on('SIGTERM', () => handleShutdown('SIGTERM'))
			process.on('SIGINT', () => handleShutdown('SIGINT'))
		})
	}

	async gracefulShutdown() {
		if (this.closing) {
			console.log('Shutdown already in progress')
			return
		}
		this.closing = true
		console.log('Starting graceful shutdown...')

		const cleanup = async () => {

			// Close socket connections
			if (this.socketService && this.socketService.io) {
				await this.socketService.cleanupLocalSessionData()
				await this.socketService.io.close()
				console.log('Stopped accepting new connections')
			}

			await Promise.all([
				// Clear local caches only when not using shared redis
				(async () => {
					if (Config.STORAGE_STRATEGY !== 'redis') {
						if (this.socketDataStorage) {
							await this.socketDataStorage.clear()
							console.log('Local socket data cleared')
						}
						if (this.cachedTokenStorage) {
							await this.cachedTokenStorage.clear()
							console.log('Local token cache cleared')
						}
					}
				})(),

				// Close Redis client if it exists
				this.redisClient && (async () => {
					await this.redisClient.quit()
					console.log('Redis client closed')
				})(),

				// Close HTTP server
				new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						reject(new Error('Server close timeout'))
					}, Config.FORCE_CLOSE_TIMEOUT)

					this.server.close(() => {
						clearTimeout(timeout)
						console.log('HTTP server closed')
						resolve()
					})
				}),
			])
		}

		try {
			await cleanup()
			console.log('Graceful shutdown completed')
		} catch (error) {
			console.error('Error during graceful shutdown:', error)
			throw error
		}
	}

}
