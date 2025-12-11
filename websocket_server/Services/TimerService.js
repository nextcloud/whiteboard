/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import Config from '../Utilities/ConfigUtility.js'

export default class TimerService {

	static CLEANUP_INTERVAL_MS = 60000
	static STALE_THRESHOLD_MS = 3600000

	constructor({ io, sessionStore, roomStateStore }) {
		this.io = io
		this.sessionStore = sessionStore
		this.roomStateStore = roomStateStore
		this.timers = new Map()
		this.cleanupInterval = null
		this.startCleanupInterval()
	}

	startCleanupInterval() {
		if (this.cleanupInterval) return
		this.cleanupInterval = setInterval(() => {
			this.cleanupStaleTimers()
		}, TimerService.CLEANUP_INTERVAL_MS)
	}

	stopCleanupInterval() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval)
			this.cleanupInterval = null
		}
	}

	cleanupStaleTimers() {
		const now = Date.now()
		for (const [roomId, timerState] of this.timers.entries()) {
			if (timerState.status === 'finished' || timerState.status === 'idle') {
				const updatedAt = timerState.updatedAt || 0
				if (now - updatedAt > TimerService.STALE_THRESHOLD_MS) {
					this.clearTimerTimeout(roomId)
					this.timers.delete(roomId)
					console.log(`[${roomId}] Cleaned up stale timer`)
				}
			}
		}
	}

	#getTimerKey(roomId) {
		return `room:${roomId}:timer`
	}

	async hydrateForSocket(roomID, socket) {
		await this.loadTimerState(roomID)
		this.emitTimerState(roomID, socket)
	}

	clearTimerTimeout(roomID) {
		const timerState = this.timers.get(roomID)
		if (timerState?.timeoutId) {
			clearTimeout(timerState.timeoutId)
			timerState.timeoutId = null
		}
	}

	getTimerPayload(roomID) {
		const timerState = this.timers.get(roomID)
		const now = Date.now()
		const updatedAt = timerState?.updatedAt ?? now

		if (!timerState) {
			return {
				status: 'idle',
				remainingMs: 0,
				durationMs: null,
				endsAt: null,
				startedBy: null,
				startedAt: null,
				pausedBy: null,
				updatedAt,
			}
		}

		const remainingMs = timerState.status === 'running' && timerState.endsAt
			? Math.max(timerState.endsAt - now, 0)
			: Math.max(timerState.remainingMs || 0, 0)

		return {
			status: timerState.status,
			remainingMs,
			durationMs: timerState.durationMs ?? null,
			endsAt: timerState.status === 'running' ? timerState.endsAt : null,
			startedBy: timerState.startedBy || null,
			startedAt: timerState.startedAt || null,
			pausedBy: timerState.pausedBy || null,
			updatedAt,
		}
	}

	emitTimerState(roomID, targetSocket = null) {
		const payload = this.getTimerPayload(roomID)

		if (targetSocket) {
			targetSocket.emit('timer-state', payload)
		} else {
			this.io.to(roomID).emit('timer-state', payload)
		}
	}

	async loadTimerState(roomID) {
		const stored = await this.roomStateStore.getValue(this.#getTimerKey(roomID))
		if (!stored) {
			return
		}

		this.clearTimerTimeout(roomID)

		const now = Date.now()
		let timeoutId = null
		let remainingMs = stored.remainingMs || 0
		let endsAt = stored.endsAt || null

		if (stored.status === 'running' && stored.endsAt) {
			const remaining = Math.max(stored.endsAt - now, 0)
			if (remaining === 0) {
				this.handleTimerFinished(roomID)
				return
			}
			timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remaining)
			remainingMs = remaining
			endsAt = now + remaining
		}

		this.timers.set(roomID, {
			...stored,
			remainingMs,
			endsAt,
			timeoutId,
		})
	}

	async persistTimerState(roomID) {
		const timerState = this.timers.get(roomID)
		if (!timerState) {
			await this.roomStateStore.deleteValue(this.#getTimerKey(roomID))
			return
		}
		const { timeoutId, ...serializable } = timerState
		await this.roomStateStore.setValue(this.#getTimerKey(roomID), serializable, {
			ttlMs: Config.SESSION_TTL,
		})
	}

	async clearRoom(roomID) {
		this.clearTimerTimeout(roomID)
		this.timers.delete(roomID)
		await this.roomStateStore.deleteValue(this.#getTimerKey(roomID))
	}

	async handleTimerFinished(roomID) {
		const timerState = this.timers.get(roomID)
		if (!timerState) {
			return
		}

		this.clearTimerTimeout(roomID)

		this.timers.set(roomID, {
			...timerState,
			status: 'finished',
			remainingMs: 0,
			endsAt: null,
			timeoutId: null,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer finished`)
		this.persistTimerState(roomID).catch((error) => {
			console.error(`[${roomID}] Failed to persist timer state:`, error)
		})
		this.emitTimerState(roomID)
	}

	async start(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		const rawDuration = Number(data?.durationMs)

		if (!roomID || !Number.isFinite(rawDuration)) {
			socket.emit('timer-error', 'Invalid timer start payload')
			return
		}

		if (await this.sessionStore.isReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const durationMs = Math.max(Math.floor(rawDuration), 1000)
		const now = Date.now()
		const userInfo = await this.getSocketUserInfo(socket.id)

		this.clearTimerTimeout(roomID)

		const timeoutId = setTimeout(() => this.handleTimerFinished(roomID), durationMs)

		this.timers.set(roomID, {
			status: 'running',
			durationMs,
			remainingMs: durationMs,
			endsAt: now + durationMs,
			startedAt: now,
			startedBy: userInfo,
			pausedBy: null,
			timeoutId,
			updatedAt: now,
		})

		console.log(`[${roomID}] Timer started for ${durationMs}ms by ${userInfo.userName}`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async pause(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer pause payload')
			return
		}

		if (await this.sessionStore.isReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || timerState.status !== 'running') {
			socket.emit('timer-error', 'No active timer to pause')
			return
		}

		const remainingMs = timerState.endsAt
			? Math.max(timerState.endsAt - Date.now(), 0)
			: timerState.remainingMs || 0

		this.clearTimerTimeout(roomID)

		this.timers.set(roomID, {
			...timerState,
			status: 'paused',
			remainingMs,
			endsAt: null,
			pausedBy: await this.getSocketUserInfo(socket.id),
			timeoutId: null,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer paused with ${remainingMs}ms remaining`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async resume(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer resume payload')
			return
		}

		if (await this.sessionStore.isReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || timerState.status !== 'paused') {
			socket.emit('timer-error', 'No paused timer to resume')
			return
		}

		const remainingMs = Math.max(timerState.remainingMs || 0, 0)
		if (remainingMs === 0) {
			this.handleTimerFinished(roomID)
			return
		}

		const endsAt = Date.now() + remainingMs
		const timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remainingMs)

		this.timers.set(roomID, {
			...timerState,
			status: 'running',
			endsAt,
			pausedBy: null,
			timeoutId,
			updatedAt: Date.now(),
		})

		console.log(`[${roomID}] Timer resumed with ${remainingMs}ms remaining`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async extend(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		const additionalMs = Number(data?.additionalMs)

		if (!roomID || !Number.isFinite(additionalMs)) {
			socket.emit('timer-error', 'Invalid timer extend payload')
			return
		}

		if (await this.sessionStore.isReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		const timerState = this.timers.get(roomID)
		if (!timerState || (timerState.status !== 'running' && timerState.status !== 'paused')) {
			socket.emit('timer-error', 'No timer to extend')
			return
		}

		const extraTime = Math.max(Math.floor(additionalMs), 1000)
		const now = Date.now()

		let endsAt = timerState.endsAt
		let remainingMs = timerState.remainingMs || 0
		let timeoutId = timerState.timeoutId || null

		if (timerState.status === 'running') {
			const currentRemaining = endsAt
				? Math.max(endsAt - now, 0)
				: remainingMs

			endsAt = now + currentRemaining + extraTime
			remainingMs = Math.max(endsAt - now, 0)

			this.clearTimerTimeout(roomID)
			timeoutId = setTimeout(() => this.handleTimerFinished(roomID), remainingMs)
		} else {
			remainingMs = (timerState.remainingMs || 0) + extraTime
			endsAt = null
			this.clearTimerTimeout(roomID)
			timeoutId = null
		}

		this.timers.set(roomID, {
			...timerState,
			durationMs: (timerState.durationMs || 0) + extraTime,
			remainingMs,
			endsAt,
			timeoutId,
			updatedAt: now,
		})

		console.log(`[${roomID}] Timer extended by ${extraTime}ms`)
		await this.persistTimerState(roomID)
		this.emitTimerState(roomID)
	}

	async reset(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null

		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer reset payload')
			return
		}

		if (await this.sessionStore.isReadOnly(socket.id)) {
			socket.emit('timer-error', 'Read-only users cannot control the timer')
			return
		}

		if (!socket.rooms.has(roomID)) {
			socket.emit('timer-error', 'Cannot control timer outside the room')
			return
		}

		await this.clearRoom(roomID)

		console.log(`[${roomID}] Timer reset`)
		this.emitTimerState(roomID)
	}

	async sendState(socket, data) {
		const roomID = data?.fileId !== undefined ? `${data.fileId}` : null
		if (!roomID) {
			socket.emit('timer-error', 'Invalid timer state request')
			return
		}

		if (!socket.rooms.has(roomID)) {
			return
		}

		await this.loadTimerState(roomID)
		this.emitTimerState(roomID, socket)
	}

	async getSocketUserInfo(socketId) {
		const socketData = await this.sessionStore.getSocketData(socketId)
		const userId = socketData?.user?.id || 'unknown'
		const userName = socketData?.user?.displayName || socketData?.user?.name || 'Unknown'

		return { userId, userName }
	}

}
