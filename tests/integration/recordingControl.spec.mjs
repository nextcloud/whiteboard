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
		delete recorders.onStop
	})

	afterEach(() => {
		vi.useRealTimers()
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
})
