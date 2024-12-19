/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import dotenv from 'dotenv'
import ServerManager from './ServerManager.js'

dotenv.config()

const {
	PORT = 3002,
	TLS,
	TLS_KEY: keyPath,
	TLS_CERT: certPath,
	STORAGE_STRATEGY = 'lru',
	BACKUP_DIR = './backup',
	MAX_BACKUPS_PER_ROOM = 5,
	LOCK_TIMEOUT = 5000,
	LOCK_RETRY_INTERVAL = 50,
	CLEANUP_INTERVAL = 300000,
	MAX_ROOMS = 1000,
	ROOM_DATA_MAX_AGE = 1800000,
	JWT_SECRET_KEY,
	METRICS_TOKEN,
	NEXTCLOUD_URL,
	IS_DEV = false,
} = process.env

const FORCE_CLOSE_TIMEOUT = 60 * 1000

async function main() {
	try {
		const serverManager = new ServerManager({
			port: PORT,
			tls: TLS,
			keyPath,
			certPath,
			storageStrategy: STORAGE_STRATEGY,
			forceCloseTimeout: FORCE_CLOSE_TIMEOUT,
			backupDir: BACKUP_DIR,
			maxBackupsPerRoom: MAX_BACKUPS_PER_ROOM,
			lockTimeout: LOCK_TIMEOUT,
			lockRetryInterval: LOCK_RETRY_INTERVAL,
			cleanupInterval: CLEANUP_INTERVAL,
			maxRooms: MAX_ROOMS,
			roomDataMaxAge: ROOM_DATA_MAX_AGE,
			jwtSecretKey: JWT_SECRET_KEY,
			sharedSecret: JWT_SECRET_KEY,
			metricsToken: METRICS_TOKEN,
			nextcloudUrl: NEXTCLOUD_URL,
			isDev: IS_DEV,
		})

		await serverManager.start()

		console.log(`Server started successfully on port ${PORT}`)

		process.on('SIGTERM', () => serverManager.gracefulShutdown())
		process.on('SIGINT', () => serverManager.gracefulShutdown())
	} catch (error) {
		console.error('Failed to start server:', error)
		process.exit(1)
	}
}

main()
