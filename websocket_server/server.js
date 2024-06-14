/* eslint-disable no-console */

import http from 'http'
import https from 'https'
import fs from 'fs'
import app from './app.js'
import { initSocket } from './socket.js'
import { gracefulShutdown, saveAllRoomsData } from './roomData.js'
import dotenv from 'dotenv'
import { parseBooleanFromEnv } from './utils.js'

dotenv.config()

const {
	PORT = 3002,
	TLS,
	TLS_KEY: keyPath,
	TLS_CERT: certPath,
} = process.env

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

const interval = setInterval(saveAllRoomsData, 60 * 60 * 1000)

const shutdown = async () => {
	clearInterval(interval) // Stop the regular saving of room data
	await gracefulShutdown(server) // Perform graceful shutdown tasks
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
