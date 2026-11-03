/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfigMock } from './configMock.js'

const recorders = vi.hoisted(() => [])

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({ NEXTCLOUD_URL: 'https://cloud.example', JWT_SECRET_KEY: 'secret' }),
}))

vi.mock('../../websocket_server/Services/RecordingService.js', async () => {
	const { EventEmitter } = await import('node:events')
	class FakeRecordingService extends EventEmitter {
		constructor() {
			super()
			this.updateToken = vi.fn(async () => {})
			this.cleanup = vi.fn(async () => true)
			recorders.push(this)
		}

		async init(url) {
			this.url = url
			return true
		}

		async startRecording() {
			return true
		}

		async stopRecording() {
			await recorders.onStop?.()
			return { localPath: '/tmp/recording.webm', recordingData: [1, 2, 3] }
		}
	}
	return { default: FakeRecordingService }
})

const { default: RecordingControlService } = await import('../../websocket_server/Services/RecordingControlService.js')

function userToken(claims = {}) {
	return jwt.sign({ userid: 'teacher', fileId: 42, isFileReadOnly: false, user: { id: 'teacher', name: 'Teacher' }, ...claims }, 'secret', { expiresIn: 60 })
}

function startData(token) {
	return { fileId: 42, recordingUrl: `https://cloud.example/apps/whiteboard/recording/42/teacher?token=${token}`, uploadToken: token }
}

function setup({ sockets = { 'tab-1': 'teacher' }, readOnly = [], recordingClients = [] } = {}) {
	const emitted = []
	const entries = new Map()
	const cluster = {
		// Like ClusterService, entries of nodes that are gone are dropped when read
		getRecordingEntry: async (room, user) => {
			const entry = entries.get(`${room}:${user}`) ?? null
			if (entry && !(await cluster.isNodeAlive(entry.nodeId))) {
				entries.delete(`${room}:${user}`)
				return null
			}
			return entry
		},
		setRecordingEntry: vi.fn(async (room, user, entry) => { entries.set(`${room}:${user}`, entry) }),
		removeRecordingEntry: vi.fn(async (room, user) => { entries.delete(`${room}:${user}`) }),
		isNodeAlive: vi.fn(async () => true),
	}
	const io = {
		to: (id) => ({ emit: (event, payload) => emitted.push({ to: id, event, payload }) }),
		in: () => ({ fetchSockets: async () => Object.keys(sockets).map((id) => ({ id })) }),
		serverSideEmit: vi.fn(),
	}
	const sessionStore = {
		isReadOnly: async (id) => readOnly.includes(id),
		getSocketData: async (id) => (sockets[id] ? { user: { id: sockets[id], name: sockets[id] }, clientType: recordingClients.includes(id) ? 'recording' : 'whiteboard' } : null),
	}
	const service = new RecordingControlService({ cluster, sessionStore, io, nodeId: 'node-a', recordingServices: new Map() })
	const socket = (id) => ({
		id,
		rooms: new Set(['42']),
		emit: (event, payload) => emitted.push({ to: id, event, payload }),
		once: () => {},
		to: () => ({ emit: () => {} }),
	})
	const events = (name) => emitted.filter((e) => e.event === name)
	return { service, cluster, entries, socket, events, sockets, io }
}

describe('RecordingControlService', () => {
	beforeEach(() => {
		recorders.length = 0
		delete recorders.onStop
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('gives the bot a read-only token and renews it until the recording stops', async () => {
		vi.useFakeTimers()
		const { service, socket, events } = setup()

		await service.startRecording(socket('tab-1'), startData(userToken()))
		const botToken = jwt.verify(new URL(recorders[0].url).searchParams.get('token'), 'secret')
		expect(botToken).toMatchObject({ userid: 'teacher', fileId: 42, isFileReadOnly: true })
		expect(events('recording-started')).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(recorders[0].updateToken).toHaveBeenCalledOnce()
		const [room, user, renewed] = recorders[0].updateToken.mock.calls[0]
		expect([room, user]).toEqual(['42', 'teacher'])
		expect(jwt.verify(renewed, 'secret')).toMatchObject({ userid: 'teacher', isFileReadOnly: true })

		await service.stopRecording(socket('tab-1'), '42')
		const [stopped] = events('recording-stopped')
		expect(jwt.verify(stopped.payload.uploadToken, 'secret')).toMatchObject({ userid: 'teacher', fileId: 42, isFileReadOnly: false })

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
		expect(recorders[0].updateToken).toHaveBeenCalledOnce()
	})

	it('does not give a writable token to a read-only socket of the recording user', async () => {
		const { service, socket, events } = setup({ sockets: { 'tab-1': 'teacher', bot: 'teacher' }, readOnly: ['bot'] })

		await service.startRecording(socket('tab-1'), startData(userToken()))
		await service.stopRecording(socket('bot'), '42')

		expect(events('recording-stopped')).toEqual([])
		expect(events('recording-error')).toEqual([{ to: 'bot', event: 'recording-error', payload: 'Read-only users cannot stop recordings' }])
	})

	it('accepts a guest whose token ids differ, but not the token of another user', async () => {
		const guest = setup({ sockets: { 'guest-tab': 'shared_AbCd123_3333' } })
		const guestToken = userToken({ userid: 'shared_AbCd123_1111', user: { id: 'shared_AbCd123_2222', name: 'Guest' } })
		await guest.service.startRecording(guest.socket('guest-tab'), startData(guestToken))
		expect(guest.events('recording-started')).toHaveLength(1)

		const other = setup({ sockets: { 'student-tab': 'student' } })
		await other.service.startRecording(other.socket('student-tab'), startData(userToken()))
		expect(other.events('recording-error').map((e) => e.payload)).toEqual(['Unauthorized'])
	})

	it('waits for a forwarded stop however long the node encodes, and reports a node that went away', async () => {
		vi.useFakeTimers()
		const { service, socket, events, entries, cluster } = setup()
		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-b', status: 'recording' })

		await service.stopRecording(socket('tab-1'), '42')
		await vi.advanceTimersByTimeAsync(60000)
		expect(events('recording-error')).toEqual([])
		expect(entries.get('42:teacher').nodeId).toBe('node-b')

		cluster.isNodeAlive.mockResolvedValue(false)
		await vi.advanceTimersByTimeAsync(5000)
		expect(events('recording-error').map((e) => e.payload)).toEqual(['Recording host unavailable, please try again'])
		await vi.advanceTimersByTimeAsync(60000)
		expect(events('recording-error')).toHaveLength(1)
	})

	it('reports a node whose heartbeat ends while a forwarded stop is checked', async () => {
		vi.useFakeTimers()
		const { service, socket, events, entries, cluster } = setup()
		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-b', status: 'recording' })
		await service.stopRecording(socket('tab-1'), '42')

		cluster.isNodeAlive.mockResolvedValueOnce(true).mockResolvedValue(false)
		await vi.advanceTimersByTimeAsync(10000)

		expect(events('recording-error').map((e) => e.payload)).toEqual(['Recording host unavailable, please try again'])
	})

	it('stops watching a forwarded stop once the node finished it, or another recording took over', async () => {
		vi.useFakeTimers()
		const { service, socket, events, entries, cluster } = setup()
		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-b', status: 'recording' })
		await service.stopRecording(socket('tab-1'), '42')
		entries.delete('42:teacher')
		await vi.advanceTimersByTimeAsync(5000)

		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-b', status: 'recording' })
		await service.stopRecording(socket('tab-1'), '42')
		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-c', status: 'recording' })
		cluster.isNodeAlive.mockImplementation(async (nodeId) => nodeId !== 'node-b')
		await vi.advanceTimersByTimeAsync(60000)

		expect(events('recording-error')).toEqual([])
		expect(entries.get('42:teacher').nodeId).toBe('node-c')
	})

	it('sends a stopped recording to another tab of the user when the stopping tab closed', async () => {
		const { service, socket, events, sockets } = setup({ sockets: { 'tab-1': 'teacher', 'tab-2': 'teacher' } })
		const upload = vi.spyOn(service, 'uploadRecordingToNextcloud').mockResolvedValue(null)

		await service.startRecording(socket('tab-1'), { ...startData(userToken()), autoUploadOnDisconnect: true })
		recorders.onStop = () => {
			delete sockets['tab-1']
		}
		await service.stopRecording(socket('tab-1'), '42')

		expect(events('recording-stopped').map((e) => e.to)).toEqual(['tab-2'])
		expect(upload).not.toHaveBeenCalled()
	})

	it('uploads a stopped recording itself when no tab of the user is left', async () => {
		const { service, socket, events, sockets } = setup()
		const upload = vi.spyOn(service, 'uploadRecordingToNextcloud').mockResolvedValue(null)

		await service.startRecording(socket('tab-1'), { ...startData(userToken()), autoUploadOnDisconnect: true })
		recorders.onStop = () => {
			delete sockets['tab-1']
		}
		await service.stopRecording(socket('tab-1'), '42')

		expect(events('recording-stopped').map((e) => e.payload)).toEqual([{ fileId: '42', uploaded: true }])
		expect(upload).toHaveBeenCalledOnce()
		expect(jwt.verify(upload.mock.calls[0][0].uploadToken, 'secret')).toMatchObject({ userid: 'teacher', isFileReadOnly: false })
	})

	it('uploads a stopped recording itself when only the recording bot is left or the tabs cannot be listed', async () => {
		const { service, socket, events, sockets, io } = setup({ sockets: { 'tab-1': 'teacher', bot: 'teacher' }, recordingClients: ['bot'] })
		const upload = vi.spyOn(service, 'uploadRecordingToNextcloud').mockResolvedValue(null)

		await service.startRecording(socket('tab-1'), { ...startData(userToken()), autoUploadOnDisconnect: true })
		recorders.onStop = () => {
			delete sockets['tab-1']
		}
		await service.stopRecording(socket('tab-1'), '42')

		sockets['tab-2'] = 'teacher'
		await service.startRecording(socket('tab-2'), { ...startData(userToken()), autoUploadOnDisconnect: true })
		io.in = () => ({
			fetchSockets: async () => {
				throw new Error('adapter down')
			},
		})
		await service.stopRecording(socket('tab-2'), '42')

		expect(upload).toHaveBeenCalledTimes(2)
		// The tab that asked learns it is saved, in case it is still there
		expect(events('recording-stopped').map((e) => [e.to, e.payload])).toEqual([
			['tab-1', { fileId: '42', uploaded: true }],
			['tab-2', { fileId: '42', uploaded: true }],
		])
	})
})
