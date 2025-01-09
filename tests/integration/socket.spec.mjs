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
		NEXTCLOUD_WEBSOCKET_URL: 'http://localhost:3009',
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

describe('Socket handling', () => {
	let serverManager, socket

	beforeAll(async () => {
		serverManager = new ServerManager()
		await serverManager.start()

		socket = io(Config.NEXTCLOUD_WEBSOCKET_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' } }, Config.JWT_SECRET_KEY),
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
		const socket = io(Config.NEXTCLOUD_WEBSOCKET_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' } }, 'wrongsecret'),
			},
		})
		return new Promise((resolve) => {
			socket.on('connect_error', () => {
				resolve()
			})
		})
	})

	it('socket valid jwt', async () => {
		const socket = io(Config.NEXTCLOUD_WEBSOCKET_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' } }, Config.JWT_SECRET_KEY),
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
		const socket = io(Config.NEXTCLOUD_WEBSOCKET_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' }, isFileReadOnly: true }, Config.JWT_SECRET_KEY),
			},
		})
		return new Promise((resolve) => {
			const readOnlyMessage = waitFor(socket, 'read-only')
			socket.on('connect', async () => {
				await readOnlyMessage
				resolve()
			})
		})
	})
})
