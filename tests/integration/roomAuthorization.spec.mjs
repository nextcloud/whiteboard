/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import RoomLifecycleService from '../../websocket_server/Services/RoomLifecycleService.js'
import SocketService from '../../websocket_server/Services/SocketService.js'

function createSubject(claims = {}) {
	const socketData = {
		...claims,
		user: { id: 'alice', name: 'Alice' },
	}
	const socket = {
		id: 'socket-alice',
		rooms: new Set(['socket-alice']),
		join: vi.fn(async (roomId) => socket.rooms.add(roomId)),
		emit: vi.fn(),
	}
	const sessionStore = {
		getSocketData: vi.fn(async () => socketData),
		isReadOnly: vi.fn(async () => false),
		setSocketData: vi.fn(async () => {}),
	}
	const cluster = {
		getRoomSyncer: vi.fn(async () => null),
		isNodeAlive: vi.fn(async () => true),
		clearRoomSyncer: vi.fn(async () => {}),
		trySetRoomSyncer: vi.fn(async () => true),
	}
	const roomEmitter = { emit: vi.fn() }
	const io = {
		in: vi.fn(() => ({ fetchSockets: vi.fn(async () => [socket]) })),
		to: vi.fn(() => roomEmitter),
	}
	const subject = new RoomLifecycleService({
		io,
		sessionStore,
		cluster,
		presentationState: { getPresentationSession: vi.fn(async () => null) },
		recordingState: { getRecordingState: vi.fn(async () => ({})) },
	})

	return { subject, socket, sessionStore, cluster, io }
}

describe('join handler authorization side effects', () => {
	it.each([
		['rejected', false, 0],
		['accepted', true, 1],
	])('applies post-join side effects when authorization is %s', async (_case, joined, expectedCalls) => {
		const context = {
			sessionStore: {
				getSocketData: vi.fn(async () => ({ user: { id: 'alice' }, clientType: 'viewer' })),
			},
			roomLifecycleController: { joinRoom: vi.fn(async () => joined) },
			cancelPendingRecordingStop: vi.fn(),
		}

		expect(await SocketService.prototype.joinRoomHandler.call(context, { id: 'socket-alice' }, 123)).toBe(joined)
		expect(context.cancelPendingRecordingStop).toHaveBeenCalledTimes(expectedCalls)
	})
})

describe('room authorization', () => {
	afterEach(() => vi.restoreAllMocks())

	it.each([
		['a missing claim', {}],
		['a mismatched fileId', { fileId: 456 }],
		['a mismatched legacy roomID', { roomID: 456 }],
		['conflicting signed claims', { fileId: 123, roomID: 456 }],
	])('rejects %s before joining', async (_case, claims) => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { subject, socket, cluster, io } = createSubject(claims)

		expect(await subject.joinRoom(socket, 123)).toBe(false)
		expect(socket.join).not.toHaveBeenCalled()
		expect(cluster.getRoomSyncer).not.toHaveBeenCalled()
		expect(io.to).not.toHaveBeenCalled()
	})

	it.each([
		['fileId', { fileId: 123 }],
		['legacy roomID', { roomID: '123' }],
		['matching claims', { fileId: 123, roomID: '123' }],
	])('joins the room authorized by %s', async (_case, claims) => {
		const { subject, socket, sessionStore, cluster } = createSubject(claims)

		expect(await subject.joinRoom(socket, '123')).toBe(true)
		expect(socket.join).toHaveBeenCalledWith('123')
		expect(cluster.trySetRoomSyncer).toHaveBeenCalledWith('123', 'alice')
		expect(sessionStore.setSocketData).toHaveBeenCalledWith('socket-alice', expect.objectContaining({
			isSyncer: true,
			syncerFor: '123',
		}))
	})
})
