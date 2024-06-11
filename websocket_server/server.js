import http from 'http'
import https from 'https'
import fs from 'fs'
import app from './app.js'
import { initSocket } from './socket.js'
import { gracefulShutdown, saveAllRoomsData } from './roomData.js'

const {
	PORT = 3002,
	TLS = false,
	TLS_KEY: key,
	TLS_CERT: cert,
} = process.env

const server = (TLS ? https : http).createServer(
	{
		key: key ? fs.readFileSync(key) : undefined,
		cert: cert ? fs.readFileSync(cert) : undefined,
	},
	app,
)

initSocket(server)

server.listen(PORT, () => {
	console.log(`Listening on port: ${PORT}`)
})

const interval = setInterval(saveAllRoomsData, 60 * 60 * 1000)

// Graceful Shutdown
const shutdown = async () => {
	clearInterval(interval)
	await gracefulShutdown(server)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
