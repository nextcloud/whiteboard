/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Utils from './Utils.js'
import RoomDataManager from './RoomDataManager.js'

/**
 * Manages cleanup operations for the whiteboard server
 */
export default class CleanupManager {

	/**
	 * Creates a new CleanupManager instance
	 * @param {RoomDataManager} roomDataManager - Manager for room data
	 * @param {object} options - Cleanup options
	 * @param {number} options.cleanupInterval - Interval in milliseconds for room cleanup
	 */
	constructor(roomDataManager, { cleanupInterval = 5 * 60 * 1000 } = {}) {
		this.roomDataManager = roomDataManager
		this.storageManager = roomDataManager.storageManager

		this.ROOM_CLEANUP_INTERVAL = cleanupInterval
		this.cleanupIntervals = new Set()
	}

	/**
	 * Starts periodic cleanup tasks
	 */
	startPeriodicTasks() {
		Utils.logOperation('SYSTEM', 'Starting periodic cleanup tasks...')

		const roomCleanup = setInterval(() => {
			this.cleanupRooms()
				.catch(error => Utils.logError('SYSTEM', 'Room cleanup failed:', error))
		}, this.ROOM_CLEANUP_INTERVAL)

		this.cleanupIntervals.add(roomCleanup)
	}

	/**
	 * Performs cleanup of rooms
	 * @return {Promise<void>}
	 */
	async cleanupRooms() {
		Utils.logOperation('SYSTEM', 'Running room cleanup...')
		const rooms = await this.storageManager.getRooms()

		for (const [roomId, room] of rooms.entries()) {
			try {
				await this.storageManager.delete(roomId)
				Utils.logOperation(roomId, 'Auto-saved and cleaned up room data')
			} catch (error) {
				Utils.logError(roomId, 'Failed to cleanup room:', error)
				// Try to restore room in case of error during the cleanup
				try {
					await this.storageManager.set(roomId, room)
				} catch (restoreError) {
					Utils.logError(
						roomId,
						'Failed to restore room after failed cleanup:',
						restoreError,
					)
				}
			}
		}
	}

	/**
	 * Stops all periodic cleanup tasks
	 */
	stopPeriodicTasks() {
		Utils.logOperation('SYSTEM', 'Stopping periodic cleanup tasks...')
		for (const interval of this.cleanupIntervals) {
			clearInterval(interval)
		}
		this.cleanupIntervals.clear()
	}

}
