/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import ServerService from './Services/ServerService.js'
import Config from './Utilities/ConfigUtility.js'

async function main() {
	try {
		const serverManager = new ServerService()

		await serverManager.start()

		console.log(`Server started successfully on port ${Config.PORT}`)

		process.on('SIGTERM', () => serverManager.gracefulShutdown())
		process.on('SIGINT', () => serverManager.gracefulShutdown())
	} catch (error) {
		console.error('Failed to start server:', error)
		process.exit(1)
	}
}

main()
