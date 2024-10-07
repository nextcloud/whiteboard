import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import ServerManager from '../../websocket_server/ServerManager.js'
import io from 'socket.io-client'
import jwt from 'jsonwebtoken'
import Utils from '../../websocket_server/Utils.js'

const SERVER_URL = 'http://localhost:3009'
const SECRET = 'secret'

vi.stubEnv('JWT_SECRET_KEY', SECRET)

function waitFor(socket, event) {
	return new Promise((resolve) => {
		socket.once(event, resolve)
	})
}

describe('Socket handling', () => {
	let serverManager, socket

	beforeAll(async () => {
		serverManager = new ServerManager({
			port: 3009,
			storageStrategy: 'lru',
		})

		serverManager.start()

		socket = io(SERVER_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' } }, SECRET),
			},
		})

		socket.on('connect_error', (error) => {
			throw error
		})
	})

	afterAll(async () => {
		await socket.disconnect()
		await serverManager.server.close()
	})

	it('socket invalid jwt', async () => {
		const socket = io(SERVER_URL, {
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
		const socket = io(SERVER_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' } }, SECRET),
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
		const socket = io(SERVER_URL, {
			auth: {
				token: jwt.sign({ roomID: 123, user: { name: 'Admin' }, isFileReadOnly: true }, SECRET),
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
