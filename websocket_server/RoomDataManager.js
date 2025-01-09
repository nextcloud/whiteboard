/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Room from './Room.js'
import Utils from './Utils.js'
import ApiService from './ApiService.js'
import BackupManager from './BackupManager.js'
import StorageManager from './StorageManager.js'
import { DEFAULT_EMPTY_ROOM_DATA } from './Constants.js'

/**
 * @typedef {object} RoomData
 * @property {Array} [elements] - Array of room elements
 * @property {object} [files] - Object containing file information
 * @property {number} [savedAt] - Timestamp of when the data was saved
 */

/**
 * @typedef {{
 * inputData: RoomData,
 * currentData: RoomData,
 * jwtToken: string,
 * }} SyncOptions
 */

/**
 * Manages room data synchronization, backup, and storage operations
 * @class
 */
export default class RoomDataManager {

	/**
	 * @param {StorageManager} storageManager - Manager for room storage operations
	 * @param {ApiService} apiService - Service for API communications
	 * @param {BackupManager} backupManager - Manager for backup operations
	 */
	constructor(storageManager, apiService, backupManager) {
		this.storageManager = storageManager
		this.apiService = apiService
		this.backupManager = backupManager
	}

	/**
	 * Synchronizes room data across different sources
	 * @param {string} roomId - Unique identifier for the room
	 * @param {RoomData} data - Room data to synchronize
	 * @param {Array} users - Array of users in the room
	 * @param {object} lastEditedUser - User who last edited the room
	 * @param {string} jwtToken - JWT token for authentication
	 * @return {Promise<Room|null>} Updated room instance or null if empty
	 * @throws {Error} When synchronization fails
	 */
	async syncRoomData(roomId, data, users, lastEditedUser, jwtToken) {
		Utils.logOperation(roomId, 'Starting sync', {
			hasInputData: !!data,
			hasToken: !!jwtToken,
		})

		try {
			const room = await this.getOrCreateRoom(roomId)

			const updatedData = await this.determineDataToUpdate(roomId, {
				inputData: data,
				currentData: room.data,
				jwtToken,
			})

			if (updatedData) {
				await this.updateRoomWithData(
					room,
					updatedData,
					users,
					lastEditedUser,
				)

				this.createRoomBackup(room.id, room)
			}

			return room
		} catch (error) {
			Utils.logError(roomId, 'Room sync failed', error)
			throw error
		}
	}

	/**
	 * Determines the most recent data from available sources
	 * @param {string} roomId - Room identifier
	 * @param {SyncOptions} options - Sync options containing input, current data and token
	 * @return {Promise<RoomData>} Most recent room data
	 */
	async determineDataToUpdate(roomId, { inputData, currentData, jwtToken }) {
		Utils.logOperation(roomId, 'Determining data to update', {
			hasInputData: !!inputData,
			hasCurrentData: !!currentData,
			hasToken: !!jwtToken,
		})

		let data = null

		if (inputData) {
			Utils.logOperation(roomId, 'Using input data')
			data = this.normalizeRoomData(inputData)
		} else if (jwtToken) {
			data = await this.fetchRoomData(roomId, jwtToken)
		} else if (currentData) {
			Utils.logOperation(roomId, 'Using current room data')
			data = this.normalizeRoomData(currentData)
		}

		// Always return normalized data, even if null
		return this.normalizeRoomData(data)
	}

	/**
	 * Normalizes room data to ensure consistent format
	 * @param {*} data - Raw room data to normalize
	 * @return {RoomData} Normalized room data
	 */
	normalizeRoomData(data) {
		// Always return default data structure if input is null/undefined
		if (!data) {
			return DEFAULT_EMPTY_ROOM_DATA
		}

		const normalized = {
			elements: [],
			files: {},
			savedAt: Date.now(),
		}

		if (Array.isArray(data)) {
			normalized.elements = [...data]
		} else if (typeof data === 'object') {
			normalized.elements = Array.isArray(data.elements)
				? [...data.elements]
				: data.elements
					? Object.values(data.elements)
					: []
			normalized.files = { ...(data.files || {}) }
			normalized.savedAt = data.savedAt || Date.now()
		}

		return normalized
	}

	/**
	 * Updates room with new data and creates backup
	 * @param {Room} room - Room instance to update
	 * @param {RoomData} data - New room data
	 * @param {Array} users - Updated user list
	 * @param {object} lastEditedUser - User who last edited
	 * @return {Promise<void>}
	 */
	async updateRoomWithData(room, data, users, lastEditedUser) {
		await this.updateRoom(room, data, users, lastEditedUser)
		await this.storageManager.set(room.id, room)
	}

	/**
	 * Updates room properties with new data
	 * @param {Room} room - Room instance to update
	 * @param {RoomData} data - New room data
	 * @param {Array} users - Updated user list
	 * @param {object} lastEditedUser - User who last edited
	 * @return {Promise<void>}
	 */
	async updateRoom(room, data, users, lastEditedUser) {
		if (data.elements) room.setData(data.elements)
		if (data.files) room.setFiles(data.files)
		if (users) room.setUsers(users)
		if (lastEditedUser) room.updateLastEditedUser(lastEditedUser)

		Utils.logOperation(room.id, 'Room updated', {
			elementsCount: room.data?.length || 0,
			filesCount: Object.keys(room.files || {}).length,
		})
	}

	/**
	 * Creates a backup of room data
	 * @param {string} roomId - Room identifier
	 * @param {Room} room - Room instance to backup
	 * @return {Promise<void>}
	 */
	async createRoomBackup(roomId, room) {
		const backupData = {
			elements: Array.isArray(room.data) ? [...room.data] : [],
			files: { ...room.files },
			savedAt: Date.now(),
		}

		try {
			await this.backupManager.createBackup(roomId, backupData)
			Utils.logOperation(roomId, 'Backup created', {
				elementsCount: backupData.elements.length,
				filesCount: Object.keys(backupData.files).length,
			})
		} catch (error) {
			Utils.logError(roomId, 'Backup creation failed', error)
		}
	}

	/**
	 * Fetches and validates room data from server
	 * @param {string} roomId - Room identifier
	 * @param {string} jwtToken - JWT token for authentication
	 * @return {Promise<RoomData|null>} Room data or null if fetch fails
	 */
	async fetchRoomData(roomId, jwtToken) {
		Utils.logOperation(roomId, 'Fetching server data')

		try {
			const result = await this.apiService.getRoomDataFromServer(
				roomId,
				jwtToken,
			)

			if (!this.isValidServerData(result)) {
				Utils.logOperation(
					roomId,
					'Server data is invalid, recovering from backup',
				)
				return await this.tryRecoverFromBackup(roomId)
			}

			const serverData = result.data
			const backupData = await this.tryRecoverFromBackup(roomId)

			if (
				backupData
				&& (await this.backupManager.isDataFresher(roomId, serverData))
			) {
				Utils.logOperation(
					roomId,
					'Server data is fresher than backup, using server data',
				)
				return this.normalizeRoomData(serverData)
			}

			Utils.logOperation(
				roomId,
				'Server data is older than backup, using backup data',
			)
			return backupData
				? this.normalizeRoomData(backupData)
				: this.normalizeRoomData(serverData)
		} catch (error) {
			Utils.logError(roomId, 'Server fetch failed, using backup', error)
			return await this.tryRecoverFromBackup(roomId)
		}
	}

	/**
	 * Retrieves existing room or creates new one
	 * @param {string} roomId - Room identifier
	 * @return {Promise<Room>} Room instance
	 */
	async getOrCreateRoom(roomId) {
		return (await this.storageManager.get(roomId)) || new Room(roomId)
	}

	/**
	 * Validates server response data structure
	 * @param {object} result - Server response
	 * @return {boolean} Whether data is valid
	 */
	isValidServerData(result) {
		return (
			result?.data
			&& (Array.isArray(result.data.elements)
				|| typeof result.data.elements === 'object')
		)
	}

	/**
	 * Attempts to recover room data from backup
	 * @param {string} roomId - Room identifier
	 * @return {Promise<RoomData|null>} Recovered data or null
	 */
	async tryRecoverFromBackup(roomId) {
		const backupData = await this.backupManager.recoverFromBackup(roomId)
		if (backupData) {
			Utils.logOperation(roomId, 'Recovered from backup')
		}
		return backupData
	}

}
