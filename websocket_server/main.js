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
} = process.env

const FORCE_CLOSE_TIMEOUT = 60 * 60 * 1000

async function main() {
	try {
		const serverManager = new ServerManager({
			port: PORT,
			tls: TLS,
			keyPath,
			certPath,
			storageStrategy: STORAGE_STRATEGY,
			forceCloseTimeout: FORCE_CLOSE_TIMEOUT,
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
