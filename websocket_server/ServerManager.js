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
import Utils from './Utils.js'
import BackupManager from './BackupManager.js'
import CleanupManager from './CleanupManager.js'

export default class ServerManager {

	constructor(config) {
		this.config = config
		this.closing = false
		this.tokenGenerator = new SharedTokenGenerator()
		this.apiService = new ApiService(this.tokenGenerator)
		this.backupManager = new BackupManager({})
		this.storageManager = StorageManager.create(this.config.storageStrategy, this.apiService)
		this.roomDataManager = new RoomDataManager(this.storageManager, this.apiService, this.backupManager)
		this.appManager = new AppManager(this.storageManager)
		this.server = this.createConfiguredServer(this.appManager.getApp())
		this.socketManager = new SocketManager(this.server, this.roomDataManager, this.storageManager)
		this.cleanupManager = new CleanupManager(
			this.socketManager.socketDataManager,
			this.roomDataManager,
		)

		// Start periodic cleanup tasks when server starts
		this.cleanupManager.startPeriodicTasks()
	}

	readTlsCredentials(keyPath, certPath) {
		return {
			key: keyPath ? fs.readFileSync(keyPath) : undefined,
			cert: certPath ? fs.readFileSync(certPath) : undefined,
		}
	}

	createConfiguredServer(app) {
		const useTls = Utils.parseBooleanFromEnv(this.config.tls)
		const serverType = useTls ? https : http
		const serverOptions = useTls ? this.readTlsCredentials(this.config.keyPath, this.config.certPath) : {}

		return serverType.createServer(serverOptions, app)
	}

	start() {
		return new Promise((resolve, reject) => {
			this.server.listen(this.config.port, () => {
				console.log(`Listening on port: ${this.config.port}`)
				resolve()
			})

			this.server.on('error', (error) => {
				console.error('Server error:', error)
				reject(error)
			})

			process.on('SIGTERM', () => this.gracefulShutdown())
			process.on('SIGINT', () => this.gracefulShutdown())
		})
	}

	async gracefulShutdown() {
		if (this.closing) return
		this.closing = true
		console.log('Received shutdown signal, performing cleanup...')

		try {
			// Stop periodic cleanup tasks
			this.cleanupManager.stopPeriodicTasks()

			// Run one final cleanup
			await this.cleanupManager.cleanupRooms()

			// Continue with existing shutdown logic
			this.socketManager.io.close()
			console.log('Closing server...')
			this.server.close(() => {
				console.log('HTTP server closed.')
				process.exit(0)
			})

			setTimeout(() => {
				console.error('Force closing server after timeout')
				process.exit(1)
			}, this.config.forceCloseTimeout)
		} catch (error) {
			console.error('Error during graceful shutdown:', error)
			process.exit(1)
		}
	}

}
