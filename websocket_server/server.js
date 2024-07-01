/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import app from './app.js'
import { initSocket } from './socket.js'
import { removeAllRoomData, saveAllRoomsData } from './roomData.js'
import dotenv from 'dotenv'
import { parseBooleanFromEnv } from './utils.js'

dotenv.config()

const {
	PORT = 3002,
	TLS,
	TLS_KEY: keyPath,
	TLS_CERT: certPath,
} = process.env

const FORCE_CLOSE_TIMEOUT = 60 * 60 * 1000

const readTlsCredentials = (keyPath, certPath) => ({
	key: keyPath ? fs.readFileSync(keyPath) : undefined,
	cert: certPath ? fs.readFileSync(certPath) : undefined,
})

const createConfiguredServer = (app) => {
	const useTls = parseBooleanFromEnv(TLS)
	const serverType = useTls ? https : http
	const serverOptions = useTls ? readTlsCredentials(keyPath, certPath) : {}

	return serverType.createServer(serverOptions, app)
}

const server = createConfiguredServer(app)

initSocket(server)

server.listen(PORT, () => {
	console.log(`Listening on port: ${PORT}`)
})

export const gracefulShutdown = async (server) => {
	console.log('Received shutdown signal, saving all data...')
	await saveAllRoomsData()

	console.log('Clear all room data...')
	await removeAllRoomData()

	console.log('Closing server...')
	server.close(() => {
		console.log('HTTP server closed.')
		process.exit(0)
	})

	setTimeout(() => {
		console.error('Force closing server after 1 hour')
		process.exit(1)
	}, FORCE_CLOSE_TIMEOUT)
}

const shutdown = async () => {
	await gracefulShutdown(server) // Perform graceful shutdown tasks
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
