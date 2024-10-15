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
import Config from './Config.js'

export default class ServerManager {

	constructor() {
		this.closing = false
		this.tokenGenerator = new SharedTokenGenerator()
		this.apiService = new ApiService(this.tokenGenerator)
		this.storageManager = StorageManager.create(Config.STORAGE_STRATEGY, this.apiService)
		this.roomDataManager = new RoomDataManager(this.storageManager, this.apiService)
		this.appManager = new AppManager(this.storageManager)
		this.server = this.createConfiguredServer(this.appManager.getApp())
		this.socketManager = new SocketManager(this.server, this.roomDataManager, this.storageManager)
	}

	readTlsCredentials(keyPath, certPath) {
		return {
			key: keyPath ? fs.readFileSync(keyPath) : undefined,
			cert: certPath ? fs.readFileSync(certPath) : undefined,
		}
	}

	createConfiguredServer(app) {
		const useTls = Config.USE_TLS
		const serverType = useTls ? https : http
		const serverOptions = useTls ? this.readTlsCredentials(Config.TLS_KEY_PATH, Config.TLS_CERT_PATH) : {}

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

			process.on('SIGTERM', () => this.gracefulShutdown())
			process.on('SIGINT', () => this.gracefulShutdown())
		})
	}

	async gracefulShutdown() {
		if (this.closing) return
		this.closing = true
		console.log('Received shutdown signal, saving all data...')
		try {
			await this.roomDataManager.removeAllRoomData()
			this.socketManager.io.close()
			console.log('Closing server...')

			await new Promise((resolve) => {
				this.server.close(() => {
					console.log('HTTP server closed.')
					resolve()
				})
			})

			if (!Config.IS_TEST_ENV) {
				process.exit(0)
			}
		} catch (error) {
			console.error('Error during graceful shutdown:', error)
			if (!Config.IS_TEST_ENV) {
				process.exit(1)
			} else {
				throw error
			}
		}
	}

}
