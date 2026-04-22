import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'
import { createConfigMock } from './configMock.js'
import ServerManagerModule from '../../websocket_server/Services/ServerService.js'
import ConfigModule from '../../websocket_server/Utilities/ConfigUtility.js'

// Set a longer timeout for socket tests
vi.setConfig({ testTimeout: 10000 })

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({
		NEXTCLOUD_URL: 'http://127.0.0.1:3009',
		PORT: '3009',
		HOST: '127.0.0.1',
		JWT_SECRET_KEY: 'secret',
		USE_TLS: false,
		STORAGE_STRATEGY: 'lru',
		MAX_UPLOAD_FILE_SIZE: 2e6,
		CACHED_TOKEN_TTL: 5 * 60 * 1000,
		COMPRESSION_ENABLED: false,
	}),
}))

const Config = ConfigModule
const ServerService = ServerManagerModule

function waitFor(socket, event) {
	return new Promise((resolve) => {
		socket.once(event, resolve)
	})
}

describe('Socket handling', () => {
	let serverManager, socket

	beforeAll(async () => {
		serverManager = new ServerService()
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
		// Disconnect the main socket
		if (socket) {
			socket.disconnect()
		}

		// Allow some time for socket cleanup
		await new Promise(resolve => setTimeout(resolve, 500))

		// Shutdown the server
		if (serverManager) {
			await serverManager.gracefulShutdown()
		}
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

	it('join room and receive sync designation', async () => {
		// Wait for sync-designate event which indicates role assignment
		const syncDesignatePromise = waitFor(socket, 'sync-designate')

		// Join the room
		socket.emit('join-room', 123)

		// Wait for the sync designation
		const syncDesignate = await syncDesignatePromise

		// Verify the sync designation contains the expected structure
		expect(syncDesignate).toHaveProperty('isSyncer')
		expect(typeof syncDesignate.isSyncer).toBe('boolean')
	})

	it('read only socket should not be designated as syncer', async () => {
		// Create a socket with read-only permissions
		const readOnlySocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID: 123,
						user: { id: 'read-only-user', name: 'ReadOnly' },
						isFileReadOnly: true,
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		// Wait for connection
		const connectPromise = waitFor(readOnlySocket, 'connect')
		await connectPromise

		// Join the room
		const syncDesignatePromise = waitFor(readOnlySocket, 'sync-designate')
		readOnlySocket.emit('join-room', 123)
		const syncDesignate = await syncDesignatePromise

		// Verify the read-only socket is not designated as syncer
		expect(syncDesignate.isSyncer).toBe(false)

		// Test that read-only socket cannot broadcast
		const testData = new ArrayBuffer(8)
		const testIv = new ArrayBuffer(8)
		readOnlySocket.emit('server-broadcast', 123, testData, testIv)

		// We can't easily test that no broadcast occurred, but we can at least
		// verify the socket is still connected after attempting to broadcast
		expect(readOnlySocket.connected).toBe(true)

		// Clean up
		readOnlySocket.disconnect()
	})

	it('should emit room-user-change when users join', async () => {
		// Create a new socket for this test
		const newSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID: 123,
						user: { id: 'new-user', name: 'NewUser' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		// Wait for connection
		await waitFor(newSocket, 'connect')

		// Add a small delay to ensure the socket is fully connected
		await new Promise(resolve => setTimeout(resolve, 50))

		// Listen for room-user-change event on the original socket
		const userChangePromise = waitFor(socket, 'room-user-change')

		// New user joins the room
		newSocket.emit('join-room', 123)

		// Wait for the room-user-change event with a timeout
		const userChangeData = await Promise.race([
			userChangePromise,
			new Promise((_resolve, reject) =>
				setTimeout(() => reject(new Error('Timeout waiting for room-user-change event')), 2000),
			),
		])

		// Verify the user change data
		expect(Array.isArray(userChangeData)).toBe(true)

		expect(userChangeData.length).toBeGreaterThan(0)

		// Verify the user data contains the expected properties
		if (userChangeData.length > 0) {
			expect(userChangeData[0]).toHaveProperty('socketId')
			expect(userChangeData[0]).toHaveProperty('userId')
			expect(userChangeData[0]).toHaveProperty('user')
		}

		// Clean up
		newSocket.disconnect()
	})

	it('clears the old syncer when the room empties', async () => {
		const roomID = 456

		const bobSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'bob-user', name: 'Bob' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		await waitFor(bobSocket, 'connect')
		const bobDesignationPromise = waitFor(bobSocket, 'sync-designate')
		bobSocket.emit('join-room', roomID)
		const bobDesignation = await bobDesignationPromise
		expect(bobDesignation.isSyncer).toBe(true)

		bobSocket.disconnect()
		await new Promise(resolve => setTimeout(resolve, 100))

		const adminSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'admin-user', name: 'Admin' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		await waitFor(adminSocket, 'connect')
		const adminDesignationPromise = waitFor(adminSocket, 'sync-designate')
		adminSocket.emit('join-room', roomID)
		const adminDesignation = await adminDesignationPromise
		expect(adminDesignation.isSyncer).toBe(true)

		const bobReconnectSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'bob-user', name: 'Bob' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		await waitFor(bobReconnectSocket, 'connect')
		const bobReconnectDesignationPromise = waitFor(bobReconnectSocket, 'sync-designate')
		bobReconnectSocket.emit('join-room', roomID)
		const bobReconnectDesignation = await bobReconnectDesignationPromise
		expect(bobReconnectDesignation.isSyncer).toBe(false)

		bobReconnectSocket.disconnect()
		adminSocket.disconnect()
	})

	it('direct scene broadcasts reach only the targeted socket', async () => {
		const roomID = 789
		const senderSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'sender-user', name: 'Sender' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})
		const targetSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'target-user', name: 'Target' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})
		const observerSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{
						roomID,
						user: { id: 'observer-user', name: 'Observer' },
					},
					Config.JWT_SECRET_KEY,
				),
			},
		})

		await Promise.all([
			waitFor(senderSocket, 'connect'),
			waitFor(targetSocket, 'connect'),
			waitFor(observerSocket, 'connect'),
		])

		const senderDesignationPromise = waitFor(senderSocket, 'sync-designate')
		const targetDesignationPromise = waitFor(targetSocket, 'sync-designate')
		const observerDesignationPromise = waitFor(observerSocket, 'sync-designate')

		senderSocket.emit('join-room', roomID)
		targetSocket.emit('join-room', roomID)
		observerSocket.emit('join-room', roomID)

		await Promise.all([
			senderDesignationPromise,
			targetDesignationPromise,
			observerDesignationPromise,
		])

		const payload = new TextEncoder().encode(JSON.stringify({
			type: 'SCENE_INIT',
			payload: {
				elements: [{ id: 'shape-1' }],
			},
		}))
		const targetMessagePromise = waitFor(targetSocket, 'client-broadcast')
		const observerMessages = []
		observerSocket.on('client-broadcast', (...args) => {
			observerMessages.push(args)
		})

		senderSocket.emit('server-direct-broadcast', `${roomID}`, targetSocket.id, payload, [])

		const receivedPayload = await Promise.race([
			targetMessagePromise,
			new Promise((_resolve, reject) =>
				setTimeout(() => reject(new Error('Timeout waiting for targeted client-broadcast event')), 2000),
			),
		])
		const decodedPayload = new TextDecoder().decode(receivedPayload)

		expect(decodedPayload).toContain('"type":"SCENE_INIT"')
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(observerMessages).toHaveLength(0)

		senderSocket.disconnect()
		targetSocket.disconnect()
		observerSocket.disconnect()
	})

})
