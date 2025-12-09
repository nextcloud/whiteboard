/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class ClusterState {

	constructor({
		distributedState,
		nodePresence,
		nodeId,
		sessionTtl,
	} = {}) {
		this.distributedState = distributedState
		this.nodePresence = nodePresence
		this.nodeId = nodeId
		this.sessionTtl = sessionTtl
	}

	#getPresentationKey(roomId) {
		return `room:${roomId}:presentation`
	}

	#getRecordingStateKey(roomId) {
		return `room:${roomId}:recording`
	}

	#getRoomSyncerKey(roomId) {
		return `room:${roomId}:syncer`
	}

	async getPresentation(roomId) {
		return this.distributedState.getValue(this.#getPresentationKey(roomId), {
			isStale: async (value) => value?.nodeId && !(await this.nodePresence.isAlive(value.nodeId)),
		})
	}

	async setPresentation(roomId, session) {
		const payload = {
			...session,
			nodeId: session?.nodeId || this.nodeId,
		}
		await this.distributedState.setValue(this.#getPresentationKey(roomId), payload, {
			ttlMs: this.sessionTtl,
		})
		return payload
	}

	async clearPresentation(roomId) {
		await this.distributedState.deleteValue(this.#getPresentationKey(roomId))
	}

	async getRecordingState(roomId) {
		return this.distributedState.getHash(this.#getRecordingStateKey(roomId), {
			isStale: async (entry) => entry?.nodeId && !(await this.nodePresence.isAlive(entry.nodeId)),
		})
	}

	async setRecordingEntry(roomId, userId, entry) {
		const payload = {
			...entry,
			userId,
			nodeId: entry?.nodeId || this.nodeId,
		}
		await this.distributedState.setHashEntry(this.#getRecordingStateKey(roomId), userId, payload, {
			ttlMs: this.sessionTtl,
		})
		return payload
	}

	async removeRecordingEntry(roomId, userId) {
		return this.distributedState.deleteHashEntry(this.#getRecordingStateKey(roomId), userId)
	}

	async getSyncer(roomId) {
		return this.distributedState.getValue(this.#getRoomSyncerKey(roomId), {
			isStale: async (entry) => entry?.nodeId && !(await this.nodePresence.isAlive(entry.nodeId)),
		})
	}

	async setSyncer(roomId, userId) {
		await this.distributedState.setValue(
			this.#getRoomSyncerKey(roomId),
			{ userId, nodeId: this.nodeId },
			{ ttlMs: this.sessionTtl },
		)
	}

	async clearSyncer(roomId) {
		await this.distributedState.deleteValue(this.#getRoomSyncerKey(roomId))
	}

	extractRoomId(key, suffix) {
		const parts = key.split(':')
		if (parts.length < 3) return null
		if (parts[0] !== 'room') return null
		if (parts[parts.length - 1] !== suffix) return null
		return parts.slice(1, -1).join(':')
	}

	async sweep() {
		const presentationsCleared = []
		const recordingsCleared = []
		const syncersCleared = []

		const presentationKeys = await this.distributedState.listValueKeys('room:*:presentation')
		for (const key of presentationKeys) {
			const session = await this.distributedState.getValue(key)
			if (!session?.nodeId) continue
			if (await this.nodePresence.isAlive(session.nodeId)) continue

			const roomId = this.extractRoomId(key, 'presentation')
			if (!roomId) continue

			await this.clearPresentation(roomId)
			presentationsCleared.push({
				roomId,
				presenterId: session.presenterId,
				presenterName: session.presenterName,
			})
		}

		const recordingKeys = await this.distributedState.listHashKeys('room:*:recording')
		for (const key of recordingKeys) {
			const roomId = this.extractRoomId(key, 'recording')
			if (!roomId) continue

			const state = await this.distributedState.getHash(key)
			for (const entry of Object.values(state)) {
				if (!entry?.nodeId) {
					continue
				}
				if (await this.nodePresence.isAlive(entry.nodeId)) {
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

		const syncerKeys = await this.distributedState.listValueKeys('room:*:syncer')
		for (const key of syncerKeys) {
			const roomId = this.extractRoomId(key, 'syncer')
			if (!roomId) continue

			const syncer = await this.distributedState.getValue(key)
			if (!syncer?.nodeId) continue
			if (await this.nodePresence.isAlive(syncer.nodeId)) continue

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

		const presentationKeys = await this.distributedState.listValueKeys('room:*:presentation')
		for (const key of presentationKeys) {
			const session = await this.distributedState.getValue(key)
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

		const recordingKeys = await this.distributedState.listHashKeys('room:*:recording')
		for (const key of recordingKeys) {
			const roomId = this.extractRoomId(key, 'recording')
			if (!roomId) continue

			const state = await this.distributedState.getHash(key)
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

		const syncerKeys = await this.distributedState.listValueKeys('room:*:syncer')
		for (const key of syncerKeys) {
			const roomId = this.extractRoomId(key, 'syncer')
			if (!roomId) continue

			const syncer = await this.distributedState.getValue(key)
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
