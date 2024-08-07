/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import AppManager from './app.js'
import SocketManager from './socket.js'
import { createRoomDataManager } from './roomData.js'
import dotenv from 'dotenv'
import Utils from './utils.js'
import AuthManager from './auth.js'
import ApiService from './apiService.js'

dotenv.config()

const {
	PORT = 3002,
	TLS,
	TLS_KEY: keyPath,
	TLS_CERT: certPath,
	STORAGE_STRATEGY = 'redis',
} = process.env

const FORCE_CLOSE_TIMEOUT = 60 * 60 * 1000

class ServerManager {

	constructor() {
		const authManager = new AuthManager()
		const apiService = new ApiService(authManager)
		this.roomDataManager = createRoomDataManager(STORAGE_STRATEGY, apiService)
		this.appManager = new AppManager(this.roomDataManager)
		this.server = this.createConfiguredServer(this.appManager.getApp())
		this.socketManager = new SocketManager(this.server, this.roomDataManager)
	}

	readTlsCredentials(keyPath, certPath) {
		return {
			key: keyPath ? fs.readFileSync(keyPath) : undefined,
			cert: certPath ? fs.readFileSync(certPath) : undefined,
		}
	}

	createConfiguredServer(app) {
		const useTls = Utils.parseBooleanFromEnv(TLS)
		const serverType = useTls ? https : http
		const serverOptions = useTls ? this.readTlsCredentials(keyPath, certPath) : {}

		return serverType.createServer(serverOptions, app)
	}

	start() {
		this.server.listen(PORT, () => {
			console.log(`Listening on port: ${PORT}`)
		})

		process.on('SIGTERM', this.shutdown.bind(this))
		process.on('SIGINT', this.shutdown.bind(this))
	}

	async gracefulShutdown() {
		console.log('Received shutdown signal, saving all data...')
		await this.roomDataManager.removeAllRoomData()
		console.log('Closing server...')
		this.server.close(() => {
			console.log('HTTP server closed.')
			process.exit(0)
		})

		setTimeout(() => {
			console.error('Force closing server after 1 hour')
			process.exit(1)
		}, FORCE_CLOSE_TIMEOUT)
	}

	async shutdown() {
		await this.gracefulShutdown() // Perform graceful shutdown tasks
	}

}

const serverManager = new ServerManager()
serverManager.start()
