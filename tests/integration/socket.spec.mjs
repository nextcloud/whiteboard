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
					{ fileId: 123, user: { id: 'admin', name: 'Admin' } },
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

	it('rejects joining a room outside the signed JWT claim', async () => {
		const wrongRoomSocket = io(Config.NEXTCLOUD_URL, {
			auth: {
				token: jwt.sign(
					{ fileId: 123, user: { id: 'wrong-room-user', name: 'WrongRoomUser' } },
					Config.JWT_SECRET_KEY,
				),
			},
		})
		await waitFor(wrongRoomSocket, 'connect')

		wrongRoomSocket.emit('join-room', 456)
		await new Promise((resolve) => setTimeout(resolve, 50))

		const serverSocket = serverManager.socketService.io.sockets.sockets.get(wrongRoomSocket.id)
		const joinedWrongRoom = serverSocket?.rooms.has('456')
		wrongRoomSocket.disconnect()
		expect(joinedWrongRoom).toBe(false)
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

	describe('when a user disconnects', () => {
		const connectUser = async (fileId, id, name) => {
			const userSocket = io(Config.NEXTCLOUD_URL, {
				auth: { token: jwt.sign({ fileId, user: { id, name } }, Config.JWT_SECRET_KEY) },
			})
			await waitFor(userSocket, 'connect')
			return userSocket
		}

		const joinRoom = async (userSocket, roomID) => {
			const designation = waitFor(userSocket, 'sync-designate')
			userSocket.emit('join-room', roomID)
			return (await designation).isSyncer
		}

		const within = (promise, ms = 3000) => Promise.race([
			promise,
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timed out')), ms)),
		])

		it('makes another user the syncer when the syncer leaves', async () => {
			const alice = await connectUser(789, 'alice', 'Alice')
			const bob = await connectUser(789, 'bob', 'Bob')
			expect(await joinRoom(alice, 789)).toBe(true)
			expect(await joinRoom(bob, 789)).toBe(false)

			const promoted = waitFor(bob, 'sync-designate')
			alice.disconnect()

			expect(await within(promoted)).toEqual({ isSyncer: true })
			bob.disconnect()
		})

		it('ends the presentation when the presenter leaves', async () => {
			const alice = await connectUser(790, 'alice', 'Alice')
			const bob = await connectUser(790, 'bob', 'Bob')
			await joinRoom(alice, 790)
			await joinRoom(bob, 790)
			const started = waitFor(bob, 'user-started-presenting')
			alice.emit('presentation-start', { fileId: '790', userId: 'alice' })
			await within(started)

			const stopped = waitFor(bob, 'user-stopped-presenting')
			alice.disconnect()

			expect(await within(stopped)).toMatchObject({ userId: 'alice' })
			bob.disconnect()
		})

		it('keeps the timer of a board when its only user leaves and comes back', async () => {
			const alice = await connectUser(795, 'alice', 'Alice')
			const hydrated = waitFor(alice, 'timer-state')
			await joinRoom(alice, 795)
			await within(hydrated)
			const started = waitFor(alice, 'timer-state')
			alice.emit('timer-start', { fileId: '795', durationMs: 60000 })
			expect((await within(started)).status).toBe('running')
			alice.disconnect()
			await new Promise((resolve) => setTimeout(resolve, 200))

			const back = await connectUser(795, 'alice', 'Alice')
			const timer = waitFor(back, 'timer-state')
			await joinRoom(back, 795)

			expect((await within(timer)).status).toBe('running')
			back.disconnect()
		})

		it('keeps the votings of a board when its only user leaves and comes back', async () => {
			const alice = await connectUser(799, 'alice', 'Alice')
			await joinRoom(alice, 799)
			const started = waitFor(alice, 'voting-started')
			alice.emit('voting-start', '799', { question: 'Lunch?', type: 'single-choice', options: ['Pizza', 'Pho'] })
			await within(started)
			alice.disconnect()
			await new Promise((resolve) => setTimeout(resolve, 200))

			const back = await connectUser(799, 'alice', 'Alice')
			const votings = waitFor(back, 'votings-init')
			await joinRoom(back, 799)

			expect((await within(votings)).map((voting) => voting.question)).toEqual(['Lunch?'])
			back.disconnect()
		})

		it('tells the room when a user leaves while the presenter stays on another socket', async () => {
			const presenting = await connectUser(796, 'alice', 'Alice')
			const otherTab = await connectUser(796, 'alice', 'Alice')
			const bob = await connectUser(796, 'bob', 'Bob')
			await joinRoom(presenting, 796)
			await joinRoom(otherTab, 796)
			await joinRoom(bob, 796)
			const started = waitFor(bob, 'user-started-presenting')
			presenting.emit('presentation-start', { fileId: '796', userId: 'alice' })
			await within(started)

			const userChange = waitFor(bob, 'room-user-change')
			otherTab.disconnect()

			expect(await within(userChange)).toHaveLength(2)
			presenting.disconnect()
			bob.disconnect()
		})

		it('forgets the leave handling of a socket whose data is already gone', async () => {
			const { socketService } = serverManager
			const alice = await connectUser(797, 'alice', 'Alice')
			await joinRoom(alice, 797)
			const socketId = alice.id
			await socketService.sessionStore.clearSocketMeta(socketId)

			alice.disconnect()
			await vi.waitFor(() => {
				expect(socketService.io.sockets.sockets.has(socketId)).toBe(false)
			})

			await vi.waitFor(() => {
				expect(socketService.pendingDisconnects.has(socketId)).toBe(false)
			})
		})

		it('still clears the socket data when the leave handling fails', async () => {
			const { socketService } = serverManager
			const alice = await connectUser(791, 'alice', 'Alice')
			await joinRoom(alice, 791)
			const socketId = alice.id
			vi.spyOn(socketService.roomLifecycleController, 'onDisconnecting').mockRejectedValueOnce(new Error('Leave failed'))

			alice.disconnect()

			await vi.waitFor(async () => {
				expect(await socketService.sessionStore.getSocketData(socketId)).toBeFalsy()
			})
		})
	})
})
