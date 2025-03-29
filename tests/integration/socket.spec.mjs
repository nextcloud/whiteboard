import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'
import { createConfigMock } from './configMock.js'
import ServerManagerModule from '../../websocket_server/ServerManager.js'
import UtilsModule from '../../websocket_server/Utils.js'
import ConfigModule from '../../websocket_server/Config.js'

vi.mock('../../websocket_server/Config.js', () => ({
	default: createConfigMock({
		NEXTCLOUD_URL: 'http://localhost:3009',
		PORT: '3009',
		JWT_SECRET_KEY: 'secret',
	}),
}))

const Config = ConfigModule
const ServerManager = ServerManagerModule
const Utils = UtilsModule

function waitFor(socket, event) {
	return new Promise((resolve) => {
		socket.once(event, resolve)
	})
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Socket handling', () => {
	let serverManager, socket

	beforeAll(async () => {
		serverManager = new ServerManager()
		await serverManager.start()

		socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{ roomID: 123, user: { name: 'Admin' } },
					Config.JWT_SECRET_KEY,
				),
			},
		})

		socket.on('connect_error', (error) => {
			throw error
		})
	})

	afterAll(async () => {
		await socket.disconnect()
		await serverManager.gracefulShutdown()
	})

	it('socket invalid jwt', async () => {
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{ roomID: 123, user: { name: 'Admin' } },
					'wrongsecret',
				),
			},
		})
		return new Promise((resolve) => {
			socket.on('connect_error', () => {
				resolve()
			})
		})
	})

	it('socket valid jwt', async () => {
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{ roomID: 123, user: { name: 'Admin' } },
					Config.JWT_SECRET_KEY,
				),
			},
		})
		return new Promise((resolve) => {
			socket.on('connect', () => {
				resolve()
			})
		})
	})

	it('join room', async () => {
		const joinedDataMessage = waitFor(socket, 'joined-data')
		socket.emit('join-room', 123)
		const result = await joinedDataMessage
		const roomData = JSON.parse(Utils.convertArrayBufferToString(result))

		expect(roomData).toEqual([])
	})

	it('read only socket', async () => {
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID: 123,
						user: { name: 'Admin' },
						isFileReadOnly: true,
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})
		const readOnlyMessage = waitFor(socket, 'read-only')
		await readOnlyMessage
		socket.close()
	})

	it('should support room join', async () => {
		socket.emit('join-room', 'roomX')
		await sleep(500)
	})

	it('should allow to verify the connection with secret', async () => {
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				secret: Config.JWT_SECRET_KEY,
			},
		})
		await sleep(100)
		socket.close()
	})

	it('should decline bad secret', async () => {
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				secret: 'gibberish',
			},
		})
		await sleep(100)
		socket.close()
	})

	it('should be able to rejoin the room and get joined-data', async () => {
		// Create a new socket
		const socket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{ roomID: 123, user: { name: 'Admin' } },
					Config.JWT_SECRET_KEY,
				),
			},
		})
		const joinedDataMessage = waitFor(socket, 'joined-data')
		socket.emit('join-room', 123)
		const result = await joinedDataMessage
		const roomData = JSON.parse(Utils.convertArrayBufferToString(result))

		expect(roomData).toEqual([])
	})
})
