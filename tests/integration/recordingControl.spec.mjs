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
			this.startResult = recorders.nextStartResult ?? true
			this.updateToken = vi.fn(async () => {})
			this.cleanup = vi.fn(async () => true)
			recorders.push(this)
		}

		async init(url) {
			this.url = url
			return true
		}

		async startRecording() {
			await recorders.onStart?.()
			return this.startResult
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

function setup({ sockets = { 'tab-1': 'teacher' }, readOnly = [] } = {}) {
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
		getSocketData: async (id) => (sockets[id] ? { user: { id: sockets[id], name: sockets[id] } } : null),
	}
	const service = new RecordingControlService({ cluster, sessionStore, io, nodeId: 'node-a', recordingServices: new Map() })
	const socket = (id) => ({
		id,
		connected: id in sockets,
		rooms: new Set(['42']),
		emit: (event, payload) => emitted.push({ to: id, event, payload }),
		to: () => ({ emit: () => {} }),
	})
	const events = (name) => emitted.filter((e) => e.event === name)
	return { service, cluster, entries, socket, events, sockets }
}

describe('RecordingControlService', () => {
	beforeEach(() => {
		recorders.length = 0
		delete recorders.nextStartResult
		delete recorders.onStart
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

	it('ends a recording whose page fails and sends it to the user\'s current tab', async () => {
		const { service, socket, events, cluster, sockets } = setup()
		const unhandled = vi.fn()
		process.on('unhandledRejection', unhandled)

		await service.startRecording(socket('tab-1'), startData(userToken()))
		delete sockets['tab-1']
		sockets['tab-2'] = 'teacher'
		cluster.removeRecordingEntry.mockRejectedValueOnce(new Error('Redis is gone'))
		recorders[0].emit('error', new Error('Page crashed!'))

		await vi.waitFor(() => expect(events('recording-stopped')).toHaveLength(1))
		expect(events('recording-stopped')[0].to).toBe('tab-2')
		expect(recorders[0].cleanup).toHaveBeenCalledOnce()
		expect(service.recordingServices.size).toBe(0)
		await new Promise((resolve) => setTimeout(resolve, 10))
		process.off('unhandledRejection', unhandled)
		expect(unhandled).not.toHaveBeenCalled()
	})

	it('starts one recording when the same user starts twice at once', async () => {
		vi.useFakeTimers()
		const { service, socket, events } = setup()

		await Promise.all([
			service.startRecording(socket('tab-1'), startData(userToken())),
			service.startRecording(socket('tab-1'), startData(userToken())),
		])

		expect(events('recording-started')).toHaveLength(1)
		expect(events('recording-error').map((e) => e.payload)).toEqual(['Recording already in progress'])
		expect(recorders.filter((recorder) => recorder.cleanup.mock.calls.length)).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(1)
	})

	it('ignores a failure of a recorder that already ended', async () => {
		const { service, socket, events } = setup()

		await service.startRecording(socket('tab-1'), startData(userToken()))
		await service.stopRecording(socket('tab-1'), '42')
		await service.startRecording(socket('tab-1'), startData(userToken()))
		recorders[0].emit('error', new Error('Browser disconnected'))
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(events('recording-stopped')).toHaveLength(1)
		expect(recorders[1].cleanup).not.toHaveBeenCalled()
		expect(service.recordingServices.size).toBe(1)
	})

	it('closes a recorder that fails to start', async () => {
		recorders.nextStartResult = false
		const { service, socket, events } = setup()

		await service.startRecording(socket('tab-1'), startData(userToken()))

		expect(events('recording-error').map((e) => e.payload)).toEqual(['Recorder failed to start'])
		expect(recorders[0].cleanup).toHaveBeenCalledOnce()
		expect(service.recordingServices.size).toBe(0)
	})

	it('rolls back a start that fails after the recorder started', async () => {
		vi.useFakeTimers()
		const { service, socket, events, cluster, entries } = setup()
		cluster.setRecordingEntry.mockImplementationOnce(async (room, user, entry) => {
			entries.set(`${room}:${user}`, entry)
			throw new Error('Redis is gone')
		})

		await service.startRecording(socket('tab-1'), startData(userToken()))
		expect(events('recording-error').map((e) => e.payload)).toEqual(['Redis is gone'])
		expect(service.recordingServices.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)

		await service.startRecording(socket('tab-1'), startData(userToken()))
		expect(events('recording-started')).toHaveLength(1)
	})

	it('keeps a recording another node is still stopping, and reports one whose node is gone', async () => {
		vi.useFakeTimers()
		const { service, socket, events, entries, cluster } = setup()
		entries.set('42:teacher', { userId: 'teacher', nodeId: 'node-b', status: 'recording' })

		await service.stopRecording(socket('tab-1'), '42')
		await vi.advanceTimersByTimeAsync(3000)
		expect(events('recording-error')).toEqual([])
		expect(entries.has('42:teacher')).toBe(true)

		await service.stopRecording(socket('tab-1'), '42')
		cluster.isNodeAlive.mockResolvedValue(false)
		await vi.advanceTimersByTimeAsync(3000)
		expect(events('recording-error').map((e) => e.payload)).toEqual(['Recording host unavailable, please try again'])
		expect(entries.has('42:teacher')).toBe(false)
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

		expect(events('recording-stopped')).toEqual([])
		expect(upload).toHaveBeenCalledOnce()
		expect(jwt.verify(upload.mock.calls[0][0].uploadToken, 'secret')).toMatchObject({ userid: 'teacher', isFileReadOnly: false })
	})

	it('closes a recorder whose user left while it started', async () => {
		vi.useFakeTimers()
		const { service, socket, events, entries } = setup()
		const tab = socket('tab-1')
		recorders.onStart = () => {
			tab.connected = false
		}

		await service.startRecording(tab, startData(userToken()))

		expect(events('recording-started')).toEqual([])
		expect(recorders[0].cleanup).toHaveBeenCalledOnce()
		expect(service.recordingServices.size).toBe(0)
		expect(entries.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})
})
