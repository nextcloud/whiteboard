/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import SharedTokenGenerator from './SharedTokenGenerator.js'
import ApiService from './ApiService.js'
import StorageManager from './StorageManager.js'
import RoomDataManager from './RoomDataManager.js'
import AppManager from './AppManager.js'
import SocketManager from './SocketManager.js'
import BackupManager from './BackupManager.js'
import PrometheusDataManager from './PrometheusDataManager.js'
import SystemMonitor from './SystemMonitor.js'
import Config from './Config.js'
import RedisStrategy from './RedisStrategy.js'

export default class ServerManager {

	constructor() {
		this.closing = false

		this.tokenGenerator = new SharedTokenGenerator()

		this.apiService = new ApiService(this.tokenGenerator)

		this.backupManager = new BackupManager()

		this.redisClient = Config.STORAGE_STRATEGY === 'redis'
			? RedisStrategy.createRedisClient()
			: null

		if (this.redisClient) {
			this.redisClient.connect().catch(error => {
				console.error('Failed to connect to Redis:', error)
				throw error
			})
		}

		this.roomStorage = StorageManager.create(
			Config.STORAGE_STRATEGY,
			this.redisClient,
			this.apiService,
			null,
		)

		this.roomDataManager = new RoomDataManager(this.roomStorage, this.apiService, this.backupManager)

		this.systemMonitor = new SystemMonitor(this.roomStorage)

		this.metricsManager = new PrometheusDataManager(this.systemMonitor)

		this.appManager = new AppManager(this.metricsManager)

		this.server = this.createConfiguredServer(this.appManager.getApp())

		this.socketDataStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageManager.create('general-redis', this.redisClient, null, { prefix: 'socket_' })
			: StorageManager.create('in-mem')

		this.cachedTokenStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageManager.create('general-redis', this.redisClient, null, { prefix: 'token_', ttl: Config.CACHED_TOKEN_TTL / 1000 })
			: StorageManager.create('general-lru', null, null, { ttl: Config.CACHED_TOKEN_TTL })

		this.socketManager = new SocketManager(
			this.server,
			this.roomDataManager,
			this.roomStorage,
			this.socketDataStorage,
			this.cachedTokenStorage,
			this.redisClient,
		)
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
			this.server.listen(Config.PORT, () => {
				console.log(`Listening on port: ${Config.PORT}`)
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
			await this.socketManager.io.close()
			console.log('Stopped accepting new connections')

			await Promise.all([
				// Storage cleanup
				(async () => {
					await this.socketDataStorage.clear()
					await this.cachedTokenStorage.clear()
					await this.roomStorage.clear()
					console.log('Storage cleared')
				})(),

				// Redis cleanup if needed
				this.redisClient && (async () => {
					await this.redisClient.quit()
					console.log('Redis client closed')
				})(),

				// Server cleanup with timeout
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
