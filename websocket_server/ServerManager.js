/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import StorageManager from './StorageManager.js'
import AppManager from './AppManager.js'
import SocketManager from './SocketManager.js'
import Config from './Config.js'
import RedisStrategy from './RedisStrategy.js'
import SystemMonitor from './SystemMonitor.js'
import PrometheusDataManager from './PrometheusDataManager.js'

export default class ServerManager {

	constructor() {
		this.closing = false

		this.redisClient = Config.STORAGE_STRATEGY === 'redis'
			? RedisStrategy.createRedisClient()
			: null

		if (this.redisClient) {
			this.redisClient.connect().catch(error => {
				console.error('Failed to connect to Redis:', error)
				throw error
			})
		}

		this.socketDataStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageManager.create('redis', this.redisClient, { prefix: 'socket_' })
			: StorageManager.create('in-mem')

		this.cachedTokenStorage = Config.STORAGE_STRATEGY === 'redis'
			? StorageManager.create('redis', this.redisClient, { prefix: 'token_' })
			: StorageManager.create('lru', null)

		// Initialize monitoring components
		this.systemMonitor = new SystemMonitor(null, this.cachedTokenStorage)
		this.metricsManager = Config.METRICS_TOKEN
			? new PrometheusDataManager(this.systemMonitor)
			: null

		// Initialize app manager with both system monitor and metrics manager
		this.appManager = new AppManager(this.systemMonitor, this.metricsManager)

		this.server = this.createConfiguredServer(this.appManager.getApp())

		this.socketManager = new SocketManager(
			this.server,
			this.socketDataStorage,
			this.cachedTokenStorage,
			this.redisClient,
		)

		// Update system monitor with socket manager reference
		this.systemMonitor.socketManager = this.socketManager

		console.log(`Server initialized with ${Config.STORAGE_STRATEGY} storage strategy`)
		console.log(`Metrics ${this.metricsManager ? 'enabled' : 'disabled'}`)
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

			// Close socket connections
			if (this.socketManager && this.socketManager.io) {
				await this.socketManager.io.close()
				console.log('Stopped accepting new connections')
			}

			await Promise.all([
				// Clear storage
				(async () => {
					if (this.socketDataStorage) await this.socketDataStorage.clear()
					if (this.cachedTokenStorage) await this.cachedTokenStorage.clear()
					console.log('Storage cleared')
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
