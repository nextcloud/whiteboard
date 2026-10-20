/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'
import ClusterService from '../../websocket_server/Services/ClusterService.js'
import RoomLifecycleService from '../../websocket_server/Services/RoomLifecycleService.js'
import SocketService from '../../websocket_server/Services/SocketService.js'
import RoomStateStore from '../../websocket_server/Stores/RoomStateStore.js'

function createRoom({ sockets, syncer = null, trySet = true }) {
	const socketData = new Map(sockets.map(({ id, ...data }) => [id, {
		user: { id: data.userId, name: data.userId },
		fileId: 1,
		nodeId: data.nodeId,
		clientType: data.clientType,
		previousSocketId: data.previousSocketId,
	}]))
	const present = new Set(sockets.map(({ id }) => id))
	const emitted = []
	const cluster = {
		getRoomSyncer: vi.fn(async () => syncer),
		releaseRoomSyncer: vi.fn(async () => true),
		trySetRoomSyncer: vi.fn(async () => trySet),
	}
	const sessionStore = {
		getSocketData: vi.fn(async (id) => socketData.get(id)),
		setSocketData: vi.fn(async (id, data) => socketData.set(id, data)),
		isReadOnly: vi.fn(async (id) => sockets.find((s) => s.id === id)?.readOnly === true),
	}
	const io = {
		// The room is '1'; any other target is the room of one socket
		in: vi.fn((target) => ({
			fetchSockets: vi.fn(async () => target === '1'
				? [...present].map((id) => ({ id }))
				: (present.has(target) ? [{ id: target, rooms: new Set([target, '1']) }] : [])),
		})),
		to: vi.fn((target) => ({ emit: (event, payload) => emitted.push([target, event, payload]) })),
	}
	const room = new RoomLifecycleService({
		io,
		sessionStore,
		cluster,
		presentationState: { getPresentationSession: vi.fn(async () => null) },
		recordingState: { getRecordingState: vi.fn(async () => ({})) },
	})
	const joiningSocket = (id) => ({ id, connected: true, rooms: new Set([id]), join: vi.fn(async () => {}), emit: vi.fn() })
	return { room, cluster, io, emitted, joiningSocket, present }
}

describe('syncer election', () => {
	it('does not make a second socket of the syncing user a syncer', async () => {
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [{ id: 'tab-1', userId: 'alice', nodeId: 'node-a' }, { id: 'tab-2', userId: 'alice', nodeId: 'node-a' }],
			syncer: { userId: 'alice', socketId: 'tab-1', nodeId: 'node-a' },
		})
		const socket = joiningSocket('tab-2')

		await room.joinRoom(socket, 1)

		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
		expect(cluster.trySetRoomSyncer).not.toHaveBeenCalled()
	})

	it('replaces a record from a relay that elected a whole user', async () => {
		const legacy = { userId: 'alice', nodeId: 'node-a' }
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [{ id: 'tab-2', userId: 'alice', nodeId: 'node-a' }],
			syncer: legacy,
		})
		const socket = joiningSocket('tab-2')

		await room.joinRoom(socket, 1)

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', legacy)
		expect(cluster.trySetRoomSyncer).toHaveBeenCalledWith('1', { userId: 'alice', socketId: 'tab-2', nodeId: 'node-a' })
		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: true })
	})

	it('gives the syncer role to the socket of a tab that reconnected', async () => {
		const old = { userId: 'alice', socketId: 'old-tab', nodeId: 'node-a' }
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [
				{ id: 'old-tab', userId: 'alice', nodeId: 'node-a' },
				{ id: 'new-tab', userId: 'alice', nodeId: 'node-a', previousSocketId: 'old-tab' },
			],
			syncer: old,
		})
		const socket = joiningSocket('new-tab')

		await room.joinRoom(socket, 1)

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', old)
		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: true })
	})

	it('keeps the syncer when another user names its socket', async () => {
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [
				{ id: 'tab-1', userId: 'alice', nodeId: 'node-a' },
				{ id: 'mallory-1', userId: 'mallory', nodeId: 'node-a', previousSocketId: 'tab-1' },
			],
			syncer: { userId: 'alice', socketId: 'tab-1', nodeId: 'node-a' },
		})
		const socket = joiningSocket('mallory-1')

		await room.joinRoom(socket, 1)

		expect(cluster.releaseRoomSyncer).not.toHaveBeenCalled()
		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
	})

	it('frees a record whose socket is no longer in the room', async () => {
		const orphan = { userId: 'alice', socketId: 'gone', nodeId: 'node-a' }
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-a' }],
			syncer: orphan,
		})
		const socket = joiningSocket('bob')

		await room.joinRoom(socket, 1)

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', orphan)
		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: true })
	})

	it('hands the role on when a joiner that cannot save freed the record', async () => {
		const legacy = { userId: 'alice', nodeId: 'node-a' }
		const { room, cluster, emitted, joiningSocket } = createRoom({
			sockets: [
				{ id: 'bob', userId: 'bob', nodeId: 'node-a' },
				{ id: 'reader', userId: 'carol', nodeId: 'node-a', readOnly: true },
			],
			syncer: legacy,
		})
		const socket = joiningSocket('reader')

		await room.joinRoom(socket, 1)

		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
		expect(cluster.trySetRoomSyncer).toHaveBeenCalledWith('1', { userId: 'bob', socketId: 'bob', nodeId: 'node-a' })
		expect(emitted).toContainEqual(['bob', 'sync-designate', { isSyncer: true }])
	})

	it('tells a joining socket it is the syncer when the room elected it during the join', async () => {
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [{ id: 'tab-a', userId: 'alice', nodeId: 'node-a' }, { id: 'bob', userId: 'bob', nodeId: 'node-a' }],
		})
		cluster.getRoomSyncer
			.mockResolvedValueOnce({ userId: 'alice', socketId: 'tab-a', nodeId: 'node-a' })
			.mockResolvedValueOnce({ userId: 'bob', socketId: 'bob', nodeId: 'node-a' })
		const socket = joiningSocket('bob')

		await room.joinRoom(socket, 1)

		expect(cluster.trySetRoomSyncer).not.toHaveBeenCalled()
		expect(socket.emit).toHaveBeenNthCalledWith(1, 'sync-designate', { isSyncer: false })
		expect(socket.emit).toHaveBeenLastCalledWith('sync-designate', { isSyncer: true })
	})

	it('hands the role on when the joining socket left during the join', async () => {
		const { room, cluster, emitted, joiningSocket, present } = createRoom({
			sockets: [{ id: 'tab-a', userId: 'alice', nodeId: 'node-a' }, { id: 'bob', userId: 'bob', nodeId: 'node-a' }],
		})
		const socket = joiningSocket('tab-a')
		cluster.trySetRoomSyncer.mockImplementationOnce(async () => {
			socket.connected = false
			present.delete('tab-a')
			return true
		})

		expect(await room.joinRoom(socket, 1)).toBe(false)

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', { userId: 'alice', socketId: 'tab-a', nodeId: 'node-a' })
		expect(emitted).toEqual([['bob', 'sync-designate', { isSyncer: true }]])
		expect(socket.emit).not.toHaveBeenCalled()
	})

	it('keeps the syncer when its socket cannot be looked up', async () => {
		const { room, cluster, io, joiningSocket } = createRoom({
			sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-a' }],
			syncer: { userId: 'alice', socketId: 'tab-b', nodeId: 'node-b' },
		})
		io.in.mockImplementation((target) => ({
			fetchSockets: vi.fn(async () => {
				if (target === 'tab-b') {
					throw new Error('timeout reached while waiting for fetchSockets response')
				}
				return [{ id: 'bob' }]
			}),
		}))
		const socket = joiningSocket('bob')

		await room.joinRoom(socket, 1)

		expect(cluster.releaseRoomSyncer).not.toHaveBeenCalled()
		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
	})

	it('never elects a version preview', async () => {
		const { room, cluster, emitted, joiningSocket } = createRoom({
			sockets: [{ id: 'preview', userId: 'alice', nodeId: 'node-a', clientType: 'preview' }],
		})
		const socket = joiningSocket('preview')

		await room.joinRoom(socket, 1)
		await room.findNewSyncer('1')

		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
		expect(cluster.trySetRoomSyncer).not.toHaveBeenCalled()
		expect(emitted.filter(([, event]) => event === 'sync-designate')).toEqual([])
	})

	it('never elects a recording client', async () => {
		const { room, cluster, joiningSocket } = createRoom({
			sockets: [{ id: 'recorder', userId: 'alice', nodeId: 'node-a', clientType: 'recording' }],
		})
		const socket = joiningSocket('recorder')

		await room.joinRoom(socket, 1)

		expect(socket.emit).toHaveBeenCalledWith('sync-designate', { isSyncer: false })
		expect(cluster.trySetRoomSyncer).not.toHaveBeenCalled()
	})

	it('elects one writable socket on its own node when the syncer leaves', async () => {
		const previous = { userId: 'alice', socketId: 'gone', nodeId: 'node-a' }
		const { room, cluster, emitted } = createRoom({
			sockets: [
				{ id: 'recorder', userId: 'alice', nodeId: 'node-a', clientType: 'recording' },
				{ id: 'reader', userId: 'carol', nodeId: 'node-a', readOnly: true },
				{ id: 'tab-2', userId: 'alice', nodeId: 'node-b' },
				{ id: 'bob', userId: 'bob', nodeId: 'node-a' },
			],
		})

		await room.findNewSyncer('1', previous)

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', previous)
		expect(cluster.trySetRoomSyncer).toHaveBeenCalledTimes(1)
		expect(cluster.trySetRoomSyncer).toHaveBeenCalledWith('1', { userId: 'alice', socketId: 'tab-2', nodeId: 'node-b' })
		expect(emitted).toEqual([['tab-2', 'sync-designate', { isSyncer: true }]])
	})

	it('elects the next socket when the elected one left meanwhile', async () => {
		const { room, cluster, emitted, present } = createRoom({
			sockets: [{ id: 'tab-1', userId: 'alice', nodeId: 'node-a' }, { id: 'bob', userId: 'bob', nodeId: 'node-a' }],
		})
		cluster.trySetRoomSyncer.mockImplementationOnce(async () => {
			present.delete('tab-1')
			return true
		})

		await room.findNewSyncer('1')

		expect(cluster.releaseRoomSyncer).toHaveBeenCalledWith('1', { userId: 'alice', socketId: 'tab-1', nodeId: 'node-a' })
		expect(cluster.trySetRoomSyncer).toHaveBeenLastCalledWith('1', { userId: 'bob', socketId: 'bob', nodeId: 'node-a' })
		expect(emitted).toEqual([['bob', 'sync-designate', { isSyncer: true }]])
	})

	it('tells the elected socket when it cannot be looked up', async () => {
		const { room, emitted, io } = createRoom({
			sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-b' }],
		})
		// Reading the room works, the check after the claim times out
		let lookups = 0
		io.in.mockImplementation(() => ({
			fetchSockets: vi.fn(async () => {
				if (lookups++ > 0) {
					throw new Error('timeout reached while waiting for fetchSockets response')
				}
				return [{ id: 'bob' }]
			}),
		}))

		await room.findNewSyncer('1')

		expect(emitted).toEqual([['bob', 'sync-designate', { isSyncer: true }]])
	})

	it('skips a socket whose data is gone', async () => {
		const { room, cluster, emitted } = createRoom({
			sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-a' }],
		})
		room.getUserSocketsInRoom = vi.fn(async () => [
			{ socketId: 'expired', userId: 'alice', userName: 'alice' },
			{ socketId: 'bob', userId: 'bob', userName: 'bob' },
		])

		await room.findNewSyncer('1')

		expect(cluster.trySetRoomSyncer).toHaveBeenCalledTimes(1)
		expect(emitted).toEqual([['bob', 'sync-designate', { isSyncer: true }]])
	})

	it('leaves the syncer that took the free slot meanwhile', async () => {
		const { room, cluster, emitted } = createRoom({
			sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-a' }],
			trySet: false,
		})

		await room.findNewSyncer('1')

		expect(emitted).toEqual([])
		expect(cluster.releaseRoomSyncer).not.toHaveBeenCalled()
	})
})

describe('syncer record', () => {
	const createCluster = () => {
		const store = new RoomStateStore({ defaultTtlMs: 1000 })
		return { store, cluster: new ClusterService({ roomStateStore: store, nodeId: 'node-a', sessionTtl: 1000 }) }
	}

	it('stores the elected socket and its node, without expiry', async () => {
		vi.useFakeTimers()
		const { cluster } = createCluster()

		await cluster.trySetSyncer('1', { userId: 'alice', socketId: 'tab-1', nodeId: 'node-b' })
		vi.advanceTimersByTime(60_000)

		expect(await cluster.getSyncer('1')).toEqual({ userId: 'alice', socketId: 'tab-1', nodeId: 'node-b' })
		vi.useRealTimers()
	})

	it('lets the record of a socket without a node expire', async () => {
		vi.useFakeTimers()
		const { cluster } = createCluster()

		await cluster.trySetSyncer('1', { userId: 'alice', socketId: 'tab-1' })
		vi.advanceTimersByTime(60_000)

		expect(await cluster.getSyncer('1')).toBeNull()
		vi.useRealTimers()
	})

	it('releases a record only while it is still the one that was read', async () => {
		const { cluster } = createCluster()
		await cluster.trySetSyncer('1', { userId: 'alice', socketId: 'tab-1' })
		const old = await cluster.getSyncer('1')
		await cluster.releaseSyncer('1', old)
		await cluster.trySetSyncer('1', { userId: 'bob', socketId: 'bob-1' })

		expect(await cluster.releaseSyncer('1', old)).toBe(false)
		expect((await cluster.getSyncer('1')).socketId).toBe('bob-1')
	})

	it('keeps a record that replaced a stale one while staleness was checked', async () => {
		const { store } = createCluster()
		await store.setValue('room:1:syncer', { socketId: 'old', nodeId: 'dead' })

		const value = await store.getValue('room:1:syncer', {
			isStale: async () => {
				await store.setValue('room:1:syncer', { socketId: 'new', nodeId: 'alive' })
				return true
			},
		})

		expect(value).toBeNull()
		expect(await store.getValue('room:1:syncer')).toEqual({ socketId: 'new', nodeId: 'alive' })
	})

	it('lists the records a node left behind, and only those, until an election replaces them', async () => {
		const { cluster } = createCluster()
		await cluster.trySetSyncer('1', { userId: 'alice', socketId: 'gone', nodeId: 'node-a' })
		await cluster.trySetSyncer('2', { userId: 'bob', socketId: 'bob-1', nodeId: 'node-b' })

		const { syncersGone } = await cluster.clearNodeState('node-a')

		expect(syncersGone).toEqual([{ roomId: '1', syncer: { userId: 'alice', socketId: 'gone', nodeId: 'node-a' } }])
		expect((await cluster.getSyncer('1')).socketId).toBe('gone')
		expect((await cluster.getSyncer('2')).socketId).toBe('bob-1')
	})
})

describe('relay sweep', () => {
	it('hands on a record of this relay whose socket is gone, and only that one', async () => {
		const gone = { userId: 'alice', socketId: 'gone', nodeId: 'node-a' }
		const context = {
			nodeId: 'node-a',
			io: { sockets: { sockets: new Map([['here', {}]]) } },
			clusterService: {
				listNodeSyncers: vi.fn(async () => [
					{ roomId: '1', syncer: gone },
					{ roomId: '2', syncer: { userId: 'bob', socketId: 'here', nodeId: 'node-a' } },
				]),
			},
			roomLifecycleController: { findNewSyncer: vi.fn(async () => {}) },
		}

		await SocketService.prototype.handOnGoneSyncers.call(context)

		expect(context.clusterService.listNodeSyncers).toHaveBeenCalledWith('node-a')
		expect(context.roomLifecycleController.findNewSyncer).toHaveBeenCalledTimes(1)
		expect(context.roomLifecycleController.findNewSyncer).toHaveBeenCalledWith('1', gone)
	})

	it('elects in the other rooms when one election fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const findNewSyncer = vi.fn(async (roomId) => {
			if (roomId === '1') {
				throw new Error('timeout reached while waiting for fetchSockets response')
			}
		})
		const context = { io: { to: vi.fn(() => ({ emit: vi.fn() })) }, roomLifecycleController: { findNewSyncer } }

		await SocketService.prototype.handleSweepResults.call(context, {
			syncersGone: [{ roomId: '1', syncer: { socketId: 'a' } }, { roomId: '2', syncer: { socketId: 'b' } }],
		})

		expect(findNewSyncer).toHaveBeenCalledWith('2', { socketId: 'b' })
		error.mockRestore()
	})

	it('keeps the previous record when the room cannot be read', async () => {
		const previous = { userId: 'alice', socketId: 'gone', nodeId: 'node-a' }
		const { room, cluster, io } = createRoom({ sockets: [{ id: 'bob', userId: 'bob', nodeId: 'node-a' }] })
		io.in.mockImplementation(() => ({
			fetchSockets: vi.fn(async () => {
				throw new Error('timeout reached while waiting for fetchSockets response')
			}),
		}))

		await expect(room.findNewSyncer('1', previous)).rejects.toThrow()

		expect(cluster.releaseRoomSyncer).not.toHaveBeenCalled()
	})
})
