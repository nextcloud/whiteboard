/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

export default class ClusterService {

	constructor({
		redisClient,
		roomStateStore,
		nodeId,
		sessionTtl,
		heartbeatTtlMs = 15000,
		heartbeatKeyPrefix = 'node:',
	} = {}) {
		this.redisClient = redisClient
		this.roomStateStore = roomStateStore
		this.nodeId = nodeId
		this.sessionTtl = sessionTtl
		this.heartbeatTtlMs = heartbeatTtlMs
		this.heartbeatKeyPrefix = heartbeatKeyPrefix
		this.onSweep = null

		this.heartbeatKey = this.buildHeartbeatKey(this.nodeId)
		this.heartbeatInterval = null
		this.stateSweepInterval = null
	}

	shouldUseRedis() {
		return !!this.redisClient
	}

	getPresentationKey(roomId) {
		return `room:${roomId}:presentation`
	}

	getRecordingKey(roomId) {
		return `room:${roomId}:recording`
	}

	getRoomSyncerKey(roomId) {
		return `room:${roomId}:syncer`
	}

	extractRoomId(key, suffix) {
		const parts = key.split(':')
		if (parts.length < 3) return null
		if (parts[0] !== 'room') return null
		if (parts[parts.length - 1] !== suffix) return null
		return parts.slice(1, -1).join(':')
	}

	buildHeartbeatKey(nodeId) {
		return `${this.heartbeatKeyPrefix}${nodeId}:heartbeat`
	}

	isClientClosedError(error) {
		return error?.name === 'ClientClosedError' || error?.message?.includes('The client is closed')
	}

	setSweepHandler(handler) {
		this.onSweep = handler
	}

	async start() {
		await this.startHeartbeat()
		this.startStateSweeper()
	}

	async stop() {
		await this.stopStateSweeper()
		await this.stopHeartbeat()
	}

	async startHeartbeat() {
		if (!this.shouldUseRedis() || this.heartbeatInterval) {
			return
		}

		const ttlSeconds = Math.max(1, Math.ceil(this.heartbeatTtlMs / 1000))
		const writeHeartbeat = async () => {
			try {
				await this.redisClient.set(this.heartbeatKey, 'alive', { EX: ttlSeconds })
			} catch (error) {
				if (this.isClientClosedError(error)) {
					return
				}
				console.error('Failed to write heartbeat:', error)
			}
		}

		await writeHeartbeat()
		this.heartbeatInterval = setInterval(writeHeartbeat, Math.max(1000, this.heartbeatTtlMs / 3))
	}

	async stopHeartbeat() {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval)
			this.heartbeatInterval = null
		}
		if (this.shouldUseRedis()) {
			try {
				await this.redisClient.del(this.heartbeatKey)
			} catch (error) {
				if (this.isClientClosedError(error)) {
					return
				}
				console.error('Failed to remove heartbeat key:', error)
			}
		}
	}

	startStateSweeper() {
		if (!this.shouldUseRedis() || this.stateSweepInterval) {
			return
		}
		const intervalMs = Math.max(2000, Math.floor(this.heartbeatTtlMs / 2))
		this.stateSweepInterval = setInterval(() => {
			this.runSweep().catch((error) => {
				console.error('Failed to sweep cluster state:', error)
			})
		}, intervalMs)
	}

	async stopStateSweeper() {
		if (this.stateSweepInterval) {
			clearInterval(this.stateSweepInterval)
			this.stateSweepInterval = null
		}
	}

	async runSweep() {
		if (!this.shouldUseRedis()) return
		const results = await this.sweep()
		if (this.onSweep) {
			await this.onSweep(results)
		}
	}

	async isNodeAlive(nodeId) {
		if (!this.shouldUseRedis() || !nodeId) {
			return true
		}
		try {
			const exists = await this.redisClient.exists(this.buildHeartbeatKey(nodeId))
			return exists === 1
		} catch (error) {
			if (this.isClientClosedError(error)) {
				return true
			}
			console.error('Failed to check node heartbeat:', error)
			return true
		}
	}

	async getPresentation(roomId) {
		return this.roomStateStore.getValue(this.getPresentationKey(roomId), {
			isStale: async (value) => value?.nodeId && !(await this.isNodeAlive(value.nodeId)),
		})
	}

	async setPresentation(roomId, session) {
		const payload = {
			...session,
			nodeId: session?.nodeId || this.nodeId,
		}
		await this.roomStateStore.setValue(this.getPresentationKey(roomId), payload, {
			ttlMs: this.sessionTtl,
		})
		return payload
	}

	async clearPresentation(roomId) {
		await this.roomStateStore.deleteValue(this.getPresentationKey(roomId))
	}

	async getRecordingState(roomId) {
		return this.roomStateStore.getHash(this.getRecordingKey(roomId), {
			isStale: async (entry) => entry?.nodeId && !(await this.isNodeAlive(entry.nodeId)),
		})
	}

	async getRecordingEntry(roomId, userId) {
		const state = await this.getRecordingState(roomId)
		return state[userId]
	}

	async setRecordingEntry(roomId, userId, entry) {
		const payload = {
			...entry,
			userId,
			nodeId: entry?.nodeId || this.nodeId,
		}
		await this.roomStateStore.setHashEntry(this.getRecordingKey(roomId), userId, payload, {
			ttlMs: this.sessionTtl,
		})
		return payload
	}

	async removeRecordingEntry(roomId, userId) {
		return this.roomStateStore.deleteHashEntry(this.getRecordingKey(roomId), userId)
	}

	async getSyncer(roomId) {
		return this.roomStateStore.getValue(this.getRoomSyncerKey(roomId), {
			isStale: async (entry) => entry?.nodeId && !(await this.isNodeAlive(entry.nodeId)),
		})
	}

	async setSyncer(roomId, userId) {
		await this.roomStateStore.setValue(
			this.getRoomSyncerKey(roomId),
			{ userId, nodeId: this.nodeId },
			{ ttlMs: this.sessionTtl },
		)
	}

	async trySetSyncer(roomId, userId) {
		return this.roomStateStore.setValueIfNotExists(
			this.getRoomSyncerKey(roomId),
			{ userId, nodeId: this.nodeId },
			{ ttlMs: this.sessionTtl },
		)
	}

	async clearSyncer(roomId) {
		await this.roomStateStore.deleteValue(this.getRoomSyncerKey(roomId))
	}

	async sweep() {
		const presentationsCleared = []
		const recordingsCleared = []
		const syncersCleared = []

		const presentationKeys = await this.roomStateStore.listValueKeys('room:*:presentation')
		for (const key of presentationKeys) {
			const session = await this.roomStateStore.getValue(key)
			if (!session?.nodeId) continue
			if (await this.isNodeAlive(session.nodeId)) continue

			const roomId = this.extractRoomId(key, 'presentation')
			if (!roomId) continue

			await this.clearPresentation(roomId)
			presentationsCleared.push({
				roomId,
				presenterId: session.presenterId,
				presenterName: session.presenterName,
			})
		}

		const recordingKeys = await this.roomStateStore.listHashKeys('room:*:recording')
		for (const key of recordingKeys) {
			const roomId = this.extractRoomId(key, 'recording')
			if (!roomId) continue

			const state = await this.roomStateStore.getHash(key)
			for (const entry of Object.values(state)) {
				if (!entry?.nodeId) {
					continue
				}
				if (await this.isNodeAlive(entry.nodeId)) {
					continue
				}
				await this.removeRecordingEntry(roomId, entry.userId)
				recordingsCleared.push({
					roomId,
					userId: entry.userId,
					username: entry.username,
				})
			}
		}

		const syncerKeys = await this.roomStateStore.listValueKeys('room:*:syncer')
		for (const key of syncerKeys) {
			const roomId = this.extractRoomId(key, 'syncer')
			if (!roomId) continue

			const syncer = await this.roomStateStore.getValue(key)
			if (!syncer?.nodeId) continue
			if (await this.isNodeAlive(syncer.nodeId)) continue

			await this.clearSyncer(roomId)
			syncersCleared.push({
				roomId,
				userId: syncer.userId,
			})
		}

		return { presentationsCleared, recordingsCleared, syncersCleared }
	}

	async clearNodeState(nodeId) {
		const presentationsCleared = []
		const recordingsCleared = []
		const syncersCleared = []

		const presentationKeys = await this.roomStateStore.listValueKeys('room:*:presentation')
		for (const key of presentationKeys) {
			const session = await this.roomStateStore.getValue(key)
			if (!session?.nodeId || session.nodeId !== nodeId) continue

			const roomId = this.extractRoomId(key, 'presentation')
			if (!roomId) continue

			await this.clearPresentation(roomId)
			presentationsCleared.push({
				roomId,
				presenterId: session.presenterId,
				presenterName: session.presenterName,
			})
		}

		const recordingKeys = await this.roomStateStore.listHashKeys('room:*:recording')
		for (const key of recordingKeys) {
			const roomId = this.extractRoomId(key, 'recording')
			if (!roomId) continue

			const state = await this.roomStateStore.getHash(key)
			for (const entry of Object.values(state)) {
				if (!entry?.nodeId || entry.nodeId !== nodeId) {
					continue
				}
				await this.removeRecordingEntry(roomId, entry.userId)
				recordingsCleared.push({
					roomId,
					userId: entry.userId,
					username: entry.username,
				})
			}
		}

		const syncerKeys = await this.roomStateStore.listValueKeys('room:*:syncer')
		for (const key of syncerKeys) {
			const roomId = this.extractRoomId(key, 'syncer')
			if (!roomId) continue

			const syncer = await this.roomStateStore.getValue(key)
			if (!syncer?.nodeId || syncer.nodeId !== nodeId) continue

			await this.clearSyncer(roomId)
			syncersCleared.push({
				roomId,
				userId: syncer.userId,
			})
		}

		return { presentationsCleared, recordingsCleared, syncersCleared }
	}

}
