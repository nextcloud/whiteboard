/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Utils from './Utils.js'

export default class CleanupManager {

	constructor(socketDataManager, roomDataManager) {
		this.socketDataManager = socketDataManager
		this.roomDataManager = roomDataManager

		this.SOCKET_CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes
		this.ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

		this.cleanupIntervals = new Set()
	}

	startPeriodicTasks() {
		Utils.logOperation('Starting periodic cleanup tasks...')

		const socketCleanup = setInterval(() => {
			this.cleanupSocketData()
				.catch(error => console.error('Socket cleanup failed:', error))
		}, this.SOCKET_CLEANUP_INTERVAL)
		this.cleanupIntervals.add(socketCleanup)

		const roomCleanup = setInterval(() => {
			this.cleanupRooms()
				.catch(error => console.error('Room cleanup failed:', error))
		}, this.ROOM_CLEANUP_INTERVAL)

		this.cleanupIntervals.add(roomCleanup)
	}

	async cleanupSocketData() {
		Utils.logOperation('Running socket data cleanup...')
		await this.socketDataManager.cleanup()
	}

	async cleanupRooms() {
		Utils.logOperation('Running room cleanup...')
		await this.roomDataManager.cleanupAllRooms()
	}

	stopPeriodicTasks() {
		Utils.logOperation('Stopping periodic cleanup tasks...')
		for (const interval of this.cleanupIntervals) {
			clearInterval(interval)
		}
		this.cleanupIntervals.clear()
	}

}
