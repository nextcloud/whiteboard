import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest'
import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'
import { RedisMemoryServer } from 'redis-memory-server'

import ServerManagerModule from '../../websocket_server/Services/ServerService.js'
import ConfigModule from '../../websocket_server/Utilities/ConfigUtility.js'

const ServerService = ServerManagerModule

const configState = vi.hoisted(() => ({
	IS_TEST_ENV: true,
	USE_TLS: false,
	TLS_KEY_PATH: null,
	TLS_CERT_PATH: null,
	STORAGE_STRATEGY: 'redis',
	REDIS_URL: null,
	FORCE_CLOSE_TIMEOUT: 2000,
	METRICS_TOKEN: null,
	JWT_SECRET_KEY: 'secret',
	MAX_UPLOAD_FILE_SIZE: 2e6,
	CACHED_TOKEN_TTL: 5000,
	SESSION_TTL: 60 * 60 * 1000,
	COMPRESSION_ENABLED: false,
	PORT: '0',
	HOST: '127.0.0.1',
	NEXTCLOUD_URL: '',
	RECORDING_DISCONNECT_GRACE_MS: 0,
}))

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => {

	const proxy = {}
	Object.keys(configState).forEach((key) => {
		Object.defineProperty(proxy, key, {
			get() {
				return configState[key]
			},
			set(value) {
				configState[key] = value
			},
		})
	})

	return { default: proxy }
})

vi.mock('../../websocket_server/Services/RecordingService.js', () => {
	class FakeRecordingService {

		async init() { return true }
		async startRecording() { return true }
		async stopRecording() {
			return {
				localPath: '/tmp/fake-recording.webm',
				recordingData: [1, 2, 3],
			}
		}

		async cleanup() { return true }

	}
	return { default: FakeRecordingService }
})

const Config = ConfigModule

vi.setConfig({ testTimeout: 30000 })

const waitFor = (socket, event) => {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const lastError = event === 'connect' && socket?.lastConnectError
				? `: ${socket.lastConnectError.message || socket.lastConnectError}`
				: ''
			reject(new Error(`Timeout waiting for ${event}${lastError}`))
		}, 5000)
		socket.once(event, (data) => {
			clearTimeout(timer)
			resolve(data)
		})
	})
}

const activeSockets = []

describe('Multi node websocket cluster with redis streams', () => {
	let redisServer
	let serverA
	let serverB
	let redisUrl
	const serverAPort = 4010
	const serverBPort = 4011
	const serverAUrl = `http://127.0.0.1:${serverAPort}`
	const serverBUrl = `http://127.0.0.1:${serverBPort}`
	const restartServerA = async () => {
		if (serverA) {
			return
		}
		configState.PORT = serverAPort.toString()
		configState.NEXTCLOUD_URL = serverAUrl
		serverA = new ServerService()
		await serverA.start()
	}

	const createSocket = (url, token, authExtras = {}) => {
		const socket = io(url, {
			transports: ['websocket'],
			forceNew: true,
			reconnectionAttempts: 10,
			reconnectionDelay: 200,
			reconnectionDelayMax: 500,
			auth: { token, ...authExtras },
		})

		socket.on('connect_error', (error) => {
			socket.lastConnectError = error
		})

		activeSockets.push(socket)
		return socket
	}

	const buildToken = (roomID, user) => jwt.sign({ roomID, user }, Config.JWT_SECRET_KEY)

	beforeAll(async () => {
		redisServer = new RedisMemoryServer()
		const host = await redisServer.getHost()
		const port = await redisServer.getPort()
		redisUrl = `redis://${host}:${port}`
		configState.REDIS_URL = redisUrl
		configState.HOST = '127.0.0.1'

		configState.PORT = serverAPort.toString()
		configState.NEXTCLOUD_URL = serverAUrl
		serverA = new ServerService()
		await serverA.start()

		configState.PORT = serverBPort.toString()
		configState.NEXTCLOUD_URL = serverBUrl
		serverB = new ServerService()
		await serverB.start()
	})

	afterEach(() => {
		activeSockets.splice(0).forEach((socket) => {
			if (socket.connected) {
				socket.disconnect()
			}
		})
	})

	afterAll(async () => {
		if (serverA) {
			await serverA.gracefulShutdown()
		}
		if (serverB) {
			await serverB.gracefulShutdown()
		}
		if (redisServer) {
			await redisServer.stop()
		}
	})

	it('shares presentation state across nodes for late joiners', async () => {
		const roomID = 'room-presentation'
		const presenterToken = buildToken(roomID, { id: 'user-a', name: 'Presenter', displayName: 'Presenter' })
		const viewerToken = buildToken(roomID, { id: 'user-b', name: 'Viewer', displayName: 'Viewer' })

		const presenterSocket = createSocket(serverAUrl, presenterToken)
		await waitFor(presenterSocket, 'connect')
		presenterSocket.emit('join-room', roomID)
		await waitFor(presenterSocket, 'sync-designate')

		presenterSocket.emit('presentation-start', { fileId: roomID, userId: 'user-a' })
		await waitFor(presenterSocket, 'presentation-started')

		const viewerSocket = createSocket(serverBUrl, viewerToken)
		await waitFor(viewerSocket, 'connect')
		viewerSocket.emit('join-room', roomID)

		const presentationNotice = await waitFor(viewerSocket, 'user-started-presenting')
		expect(presentationNotice.userId).toBe('user-a')

		const viewportRequest = new Promise((resolve) => viewerSocket.once('request-presenter-viewport', resolve))
		viewerSocket.emit('request-presenter-viewport', { fileId: roomID })
		await viewportRequest

		presenterSocket.emit('presentation-stop', { fileId: roomID })
		const stoppedEvent = await waitFor(viewerSocket, 'user-stopped-presenting')
		expect(stoppedEvent.userId).toBe('user-a')
	})

	it('stops recording when recorder disconnects and clears state', async () => {
		const roomID = 'room-recording-disconnect'
		const recorderUser = { id: 'recorder', name: 'Recorder', displayName: 'Recorder' }
		const viewerUser = { id: 'viewer', name: 'Viewer', displayName: 'Viewer' }
		const recorderToken = buildToken(roomID, recorderUser)
		const viewerToken = buildToken(roomID, viewerUser)

		const recorderSocket = createSocket(serverAUrl, recorderToken)
		await waitFor(recorderSocket, 'connect')
		recorderSocket.emit('join-room', roomID)
		await waitFor(recorderSocket, 'sync-designate')

		const viewerSocket = createSocket(serverBUrl, viewerToken)
		await waitFor(viewerSocket, 'connect')
		viewerSocket.emit('join-room', roomID)
		await waitFor(viewerSocket, 'sync-designate')

		recorderSocket.emit('start-recording', {
			fileId: roomID,
			recordingUrl: 'http://example.com',
			uploadToken: 'upload-token',
		})
		await waitFor(recorderSocket, 'recording-started')
		await waitFor(viewerSocket, 'user-started-recording')

		const stoppedNotice = waitFor(viewerSocket, 'user-stopped-recording')
		recorderSocket.disconnect()
		const stoppedPayload = await stoppedNotice
		expect(stoppedPayload.userId).toBe('recorder')

		const recordingKey = `${serverB.socketDataStorage.strategy.prefix}room:${roomID}:recording`
		const remaining = await serverB.redisClient.hLen(recordingKey)
		expect(remaining).toBe(0)

		const reconnectSocket = createSocket(serverBUrl, recorderToken)
		await waitFor(reconnectSocket, 'connect')
		reconnectSocket.emit('join-room', roomID)
		await waitFor(reconnectSocket, 'sync-designate')

		const noRecordingNotice = new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, 1200)
			reconnectSocket.once('user-started-recording', () => {
				clearTimeout(timer)
				reject(new Error('Recording should have been stopped on disconnect'))
			})
		})

		await noRecordingNotice
	})

	it('keeps recording if the user reconnects during the grace period', async () => {
		const roomID = 'room-recording-grace'
		const recorderUser = { id: 'recorder', name: 'Recorder', displayName: 'Recorder' }
		const viewerUser = { id: 'viewer', name: 'Viewer', displayName: 'Viewer' }
		const recorderToken = buildToken(roomID, recorderUser)
		const viewerToken = buildToken(roomID, viewerUser)
		const previousGrace = configState.RECORDING_DISCONNECT_GRACE_MS

		configState.RECORDING_DISCONNECT_GRACE_MS = 300

		try {
			const recorderSocket = createSocket(serverAUrl, recorderToken)
			await waitFor(recorderSocket, 'connect')
			recorderSocket.emit('join-room', roomID)
			await waitFor(recorderSocket, 'sync-designate')

			const viewerSocket = createSocket(serverAUrl, viewerToken)
			await waitFor(viewerSocket, 'connect')
			viewerSocket.emit('join-room', roomID)
			await waitFor(viewerSocket, 'sync-designate')

			recorderSocket.emit('start-recording', {
				fileId: roomID,
				recordingUrl: 'http://example.com',
				uploadToken: 'upload-token',
			})
			await waitFor(recorderSocket, 'recording-started')
			await waitFor(viewerSocket, 'user-started-recording')

			const stopUnexpected = new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 600)
				viewerSocket.once('user-stopped-recording', () => {
					clearTimeout(timer)
					reject(new Error('Recording should not stop during grace period'))
				})
			})

			recorderSocket.disconnect()
			await new Promise(resolve => setTimeout(resolve, 100))

			const reconnectSocket = createSocket(serverAUrl, recorderToken)
			await waitFor(reconnectSocket, 'connect')
			reconnectSocket.emit('join-room', roomID)
			await waitFor(reconnectSocket, 'sync-designate')

			await stopUnexpected

			const recordingKey = `${serverA.socketDataStorage.strategy.prefix}room:${roomID}:recording`
			const remaining = await serverA.redisClient.hLen(recordingKey)
			expect(remaining).toBe(1)
		} finally {
			configState.RECORDING_DISCONNECT_GRACE_MS = previousGrace
		}
	})

	it('stops recording when only remaining socket is a recording agent', async () => {
		const roomID = 'room-recording-agent'
		const recorderUser = { id: 'recorder', name: 'Recorder', displayName: 'Recorder' }
		const recorderToken = buildToken(roomID, recorderUser)

		const recorderSocket = createSocket(serverAUrl, recorderToken)
		await waitFor(recorderSocket, 'connect')
		recorderSocket.emit('join-room', roomID)
		await waitFor(recorderSocket, 'sync-designate')

		const agentSocket = createSocket(serverAUrl, recorderToken, { clientType: 'recording' })
		await waitFor(agentSocket, 'connect')
		agentSocket.emit('join-room', roomID)
		await waitFor(agentSocket, 'sync-designate')

		recorderSocket.emit('start-recording', {
			fileId: roomID,
			recordingUrl: 'http://example.com',
			uploadToken: 'upload-token',
		})
		await waitFor(recorderSocket, 'recording-started')

		const stoppedNotice = waitFor(agentSocket, 'user-stopped-recording')
		recorderSocket.disconnect()
		const stoppedPayload = await stoppedNotice
		expect(stoppedPayload.userId).toBe('recorder')

		const recordingKey = `${serverA.socketDataStorage.strategy.prefix}room:${roomID}:recording`
		const remaining = await serverA.redisClient.hLen(recordingKey)
		expect(remaining).toBe(0)
	})

	it('stops recording from another node for the same user', async () => {
		const roomID = 'room-recording-remote-stop'
		const recorderUser = { id: 'recorder', name: 'Recorder', displayName: 'Recorder' }
		const recorderToken = buildToken(roomID, recorderUser)

		const recorderSocket = createSocket(serverAUrl, recorderToken)
		await waitFor(recorderSocket, 'connect')
		recorderSocket.emit('join-room', roomID)
		await waitFor(recorderSocket, 'sync-designate')

		recorderSocket.emit('start-recording', {
			fileId: roomID,
			recordingUrl: 'http://example.com',
			uploadToken: 'upload-token',
		})
		await waitFor(recorderSocket, 'recording-started')

		const controllerSocket = createSocket(serverBUrl, recorderToken)
		await waitFor(controllerSocket, 'connect')
		controllerSocket.emit('join-room', roomID)
		await waitFor(controllerSocket, 'sync-designate')

		const stoppedPromise = waitFor(controllerSocket, 'recording-stopped')
		controllerSocket.emit('stop-recording', roomID)
		const stoppedPayload = await stoppedPromise
		expect(stoppedPayload.uploadToken).toBe('upload-token')

		const recordingKey = `${serverA.socketDataStorage.strategy.prefix}room:${roomID}:recording`
		const remaining = await serverA.redisClient.hLen(recordingKey)
		expect(remaining).toBe(0)
	})

	it('propagates viewport updates across nodes', async () => {
		const roomID = 'room-viewport'
		const presenterToken = buildToken(roomID, { id: 'presenter', name: 'Presenter', displayName: 'Presenter' })
		const viewerToken = buildToken(roomID, { id: 'viewer', name: 'Viewer', displayName: 'Viewer' })

		const presenterSocket = createSocket(serverAUrl, presenterToken)
		await waitFor(presenterSocket, 'connect')
		presenterSocket.emit('join-room', roomID)
		await waitFor(presenterSocket, 'sync-designate')

		const viewerSocket = createSocket(serverBUrl, viewerToken)
		await waitFor(viewerSocket, 'connect')
		viewerSocket.emit('join-room', roomID)
		await waitFor(viewerSocket, 'sync-designate')

		const viewportReceived = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Timeout waiting for viewport update')), 2000)
			viewerSocket.once('client-broadcast', (data) => {
				clearTimeout(timer)
				try {
					let text
					if (typeof data === 'string') {
						text = data
					} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
						text = new TextDecoder().decode(data)
					} else {
						throw new Error(`Unexpected client-broadcast payload type: ${typeof data}`)
					}
					const decoded = JSON.parse(text)
					resolve(decoded)
				} catch (error) {
					reject(error)
				}
			})
		})

		const viewportPayload = {
			type: 'VIEWPORT_UPDATE',
			payload: {
				scrollX: 10,
				scrollY: 20,
				zoom: 1.25,
			},
		}
		const encodedPayload = new TextEncoder().encode(JSON.stringify(viewportPayload))
		presenterSocket.emit('server-volatile-broadcast', roomID, encodedPayload)

		const decodedViewport = await viewportReceived
		expect(decodedViewport.type).toBe('VIEWPORT_UPDATE')
		expect(decodedViewport.payload).toMatchObject({
			userId: 'presenter',
			scrollX: 10,
			scrollY: 20,
			zoom: 1.25,
		})
	})

	it('broadcasts a presentation stop when the presenter node shuts down', async () => {
		const roomID = 'room-presenter-shutdown'
		const presenterToken = buildToken(roomID, { id: 'shutdown-presenter', name: 'Presenter', displayName: 'Presenter' })
		const viewerToken = buildToken(roomID, { id: 'shutdown-viewer', name: 'Viewer', displayName: 'Viewer' })

		const presenterSocket = createSocket(serverAUrl, presenterToken)
		await waitFor(presenterSocket, 'connect')
		presenterSocket.emit('join-room', roomID)
		await waitFor(presenterSocket, 'sync-designate')

		const viewerSocket = createSocket(serverBUrl, viewerToken)
		await waitFor(viewerSocket, 'connect')
		viewerSocket.emit('join-room', roomID)
		await waitFor(viewerSocket, 'sync-designate')

		presenterSocket.emit('presentation-start', { fileId: roomID, userId: 'shutdown-presenter' })
		await waitFor(presenterSocket, 'presentation-started')
		await waitFor(viewerSocket, 'user-started-presenting')

		const stoppedNotice = waitFor(viewerSocket, 'user-stopped-presenting')
		await serverA.gracefulShutdown()
		serverA = null

		const stoppedPayload = await stoppedNotice
		expect(stoppedPayload.userId).toBe('shutdown-presenter')

		await restartServerA()
	})

	it('reassigns syncer to remaining users when the syncer node shuts down', async () => {
		const roomID = 'room-syncer-reassign'
		const syncerToken = buildToken(roomID, { id: 'syncer-a', name: 'SyncerA', displayName: 'SyncerA' })
		const followerToken = buildToken(roomID, { id: 'syncer-b', name: 'SyncerB', displayName: 'SyncerB' })

		const syncerSocket = createSocket(serverAUrl, syncerToken)
		await waitFor(syncerSocket, 'connect')
		syncerSocket.emit('join-room', roomID)
		const syncerDesignation = await waitFor(syncerSocket, 'sync-designate')
		expect(syncerDesignation.isSyncer).toBe(true)

		const followerSocket = createSocket(serverBUrl, followerToken)
		await waitFor(followerSocket, 'connect')
		followerSocket.emit('join-room', roomID)
		const followerDesignation = await waitFor(followerSocket, 'sync-designate')
		expect(followerDesignation.isSyncer).toBe(false)

		const newSyncerNotice = waitFor(followerSocket, 'sync-designate')
		await serverA.gracefulShutdown()
		serverA = null

		const updatedDesignation = await newSyncerNotice
		expect(updatedDesignation.isSyncer).toBe(true)

		await restartServerA()
	})

	it('removes stale presentation entries during the cluster sweep', async () => {
		const roomID = 'room-stale-presentation'
		await serverB.socketService.roomStateStore.setValue(
			`room:${roomID}:presentation`,
			{
				presenterId: 'ghost',
				presenterName: 'Ghost',
				nodeId: 'ghost-node',
				startTime: Date.now() - 1000,
			},
			{ ttlMs: Config.SESSION_TTL },
		)

		await serverB.socketService.runSweep()

		const remaining = await serverB.socketService.roomStateStore.getValue(`room:${roomID}:presentation`)
		expect(remaining).toBeNull()
	})

	it('does not wipe shared session state when a peer node restarts', async () => {
		const roomID = 'room-restart'
		const presenterToken = buildToken(roomID, { id: 'node-b-presenter', name: 'NodeB', displayName: 'NodeB' })

		const presenterSocket = createSocket(serverBUrl, presenterToken)
		await waitFor(presenterSocket, 'connect')
		presenterSocket.emit('join-room', roomID)
		await waitFor(presenterSocket, 'sync-designate')

		presenterSocket.emit('presentation-start', { fileId: roomID, userId: 'node-b-presenter' })
		await waitFor(presenterSocket, 'presentation-started')

		await serverA.gracefulShutdown()
		serverA = null

		const lateViewerToken = buildToken(roomID, { id: 'late', name: 'Late', displayName: 'Late' })
		const lateViewer = createSocket(serverBUrl, lateViewerToken)
		await waitFor(lateViewer, 'connect')
		lateViewer.emit('join-room', roomID)

		const presentationNotice = await waitFor(lateViewer, 'user-started-presenting')
		expect(presentationNotice.userId).toBe('node-b-presenter')

		await restartServerA()
	})

	it('cleans stale recording entries from dead nodes before notifying joiners', async () => {
		const roomID = 'room-stale-recording'

		await serverA.socketService.setRecordingEntry(roomID, 'ghost-user', {
			userId: 'ghost-user',
			username: 'Ghost',
			uploadToken: 'ghost-upload',
			status: 'recording',
			nodeId: 'ghost-node',
			startedAt: Date.now() - 2000,
		})

		const viewerToken = buildToken(roomID, { id: 'viewer', name: 'Viewer', displayName: 'Viewer' })
		const viewerSocket = createSocket(serverBUrl, viewerToken)
		await waitFor(viewerSocket, 'connect')
		viewerSocket.emit('join-room', roomID)
		await waitFor(viewerSocket, 'sync-designate')

		const noRecordingNotice = new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, 1200)
			viewerSocket.once('user-started-recording', () => {
				clearTimeout(timer)
				reject(new Error('Stale recording should not be emitted'))
			})
		})

		await noRecordingNotice

		const recordingKey = `${serverB.socketDataStorage.strategy.prefix}room:${roomID}:recording`
		const remaining = await serverB.redisClient.hLen(recordingKey)
		expect(remaining).toBe(0)
	})
})
