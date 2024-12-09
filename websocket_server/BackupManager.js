/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { promisify } from 'util'
import Config from './Config.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/**
 * @typedef {object} BackupData
 * @property {string} id - Unique identifier for the backup
 * @property {number} timestamp - Timestamp when backup was created
 * @property {number} roomId - ID of the room
 * @property {string} checksum - SHA-256 hash of the data
 * @property {object} data - The actual backup data
 * @property {number} savedAt - Timestamp when the data was last saved
 */

/**
 * Manages backup operations for whiteboard rooms
 */
export default class BackupManager {

	/**
	 * Creates a new BackupManager instance
	 */
	constructor() {
		this.locks = new Map()
		this.init()
	}

	/**
	 * Initializes the backup directory and cleans up temporary files
	 * @throws {Error} If initialization fails
	 */
	async init() {
		try {
			await fs.mkdir(Config.BACKUP_DIR, { recursive: true })
			await this.cleanupTemporaryFiles()
		} catch (error) {
			console.error('Failed to initialize BackupManager:', error)
			throw error
		}
	}

	/**
	 * Removes temporary files from the backup directory
	 */
	async cleanupTemporaryFiles() {
		try {
			const files = await fs.readdir(Config.BACKUP_DIR)
			const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
			await Promise.all(
				tmpFiles.map((file) =>
					fs
						.unlink(path.join(Config.BACKUP_DIR, file))
						.catch(console.error),
				),
			)
		} catch (error) {
			console.error('Failed to cleanup temporary files:', error)
		}
	}

	/**
	 * Acquires a lock for a specific room
	 * @param {number} roomId - The room ID to lock
	 * @throws {Error} If lock cannot be acquired within timeout period
	 */
	async acquireLock(roomId) {
		const startTime = Date.now()
		while (this.locks.get(roomId)) {
			if (Date.now() - startTime > Config.LOCK_TIMEOUT) {
				throw new Error(`Lock acquisition timeout for room ${roomId}`)
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Config.LOCK_RETRY_INTERVAL),
			)
		}
		this.locks.set(roomId, Date.now())
	}

	/**
	 * Releases a lock for a specific room
	 * @param {number} roomId - The room ID to unlock
	 */
	async releaseLock(roomId) {
		this.locks.delete(roomId)
	}

	/**
	 * Ensures roomId is a valid number
	 * @param {number|string} roomId - The room ID to validate
	 * @return {number} The validated room ID
	 * @throws {Error} If roomId is invalid
	 */
	sanitizeRoomId(roomId) {
		const numericRoomId = Number(roomId)
		if (isNaN(numericRoomId) || numericRoomId <= 0) {
			throw new Error('Invalid room ID: must be a positive number')
		}
		return numericRoomId
	}

	/**
	 * Calculates SHA-256 checksum of data
	 * @param {string | object} data - Data to calculate checksum for
	 * @return {string} Hex string of SHA-256 hash
	 */
	calculateChecksum(data) {
		return crypto
			.createHash('sha256')
			.update(typeof data === 'string' ? data : JSON.stringify(data))
			.digest('hex')
	}

	/**
	 * Creates a new backup for a room
	 * @param {number} roomId - The room ID
	 * @param {object} data - The data to backup
	 * @return {Promise<string>} The backup ID
	 * @throws {Error} If backup creation fails
	 */
	async createBackup(roomId, data) {
		if (!roomId || !data) {
			throw new Error('Invalid backup parameters')
		}

		const sanitizedRoomId = this.sanitizeRoomId(roomId)

		try {
			await this.acquireLock(sanitizedRoomId)

			const backupData = this.prepareBackupData(sanitizedRoomId, data)
			await this.writeBackupFile(sanitizedRoomId, backupData)
			await this.cleanupOldBackups(sanitizedRoomId)

			return backupData.id
		} finally {
			await this.releaseLock(sanitizedRoomId)
		}
	}

	/**
	 * Prepares backup data structure
	 * @param {number} roomId - The room ID
	 * @param {object} data - The data to backup
	 * @return {BackupData} Prepared backup data
	 */
	prepareBackupData(roomId, data) {
		return {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			roomId,
			checksum: this.calculateChecksum(data),
			data,
			savedAt: data.savedAt || Date.now(),
		}
	}

	/**
	 * Writes backup data to file
	 * @param {number} roomId - The room ID
	 * @param {BackupData} backupData - The data to write
	 */
	async writeBackupFile(roomId, backupData) {
		const backupFile = path.join(
			Config.BACKUP_DIR,
			`${roomId}_${backupData.timestamp}.bak`,
		)
		const tempFile = `${backupFile}.tmp`

		const compressed = await gzip(JSON.stringify(backupData))
		await fs.writeFile(tempFile, compressed)
		await fs.rename(tempFile, backupFile)
	}

	/**
	 * Retrieves the latest backup for a room
	 * @param {number} roomId - The room ID
	 * @return {Promise<BackupData|null>} The latest backup or null if none exists
	 * @throws {Error} If backup retrieval fails
	 */
	async getLatestBackup(roomId) {
		const sanitizedRoomId = this.sanitizeRoomId(roomId)
		const files = await fs.readdir(Config.BACKUP_DIR)
		const roomBackups = files
			.filter(
				(f) =>
					f.startsWith(`${sanitizedRoomId}_`) && f.endsWith('.bak'),
			)
			.sort()
			.reverse()

		if (roomBackups.length === 0) return null

		try {
			const compressed = await fs.readFile(
				path.join(Config.BACKUP_DIR, roomBackups[0]),
			)
			const decompressed = await gunzip(compressed)
			const backup = JSON.parse(decompressed.toString())

			const calculatedChecksum = this.calculateChecksum(backup.data)
			if (calculatedChecksum !== backup.checksum) {
				throw new Error('Backup data corruption detected')
			}

			return backup
		} catch (error) {
			console.error(
				`Failed to read latest backup for room ${sanitizedRoomId}:`,
				error,
			)
			throw error
		}
	}

	/**
	 * Removes old backups exceeding maxBackupsPerRoom
	 * @param {number} roomId - The room ID
	 */
	async cleanupOldBackups(roomId) {
		const sanitizedRoomId = this.sanitizeRoomId(roomId)

		try {
			const files = await fs.readdir(Config.BACKUP_DIR)
			const roomBackups = files
				.filter(
					(f) =>
						f.startsWith(`${sanitizedRoomId}_`)
						&& f.endsWith('.bak'),
				)
				.sort()
				.reverse()

			if (roomBackups.length <= Config.MAX_BACKUPS_PER_ROOM) {
				return
			}

			const filesToDelete = roomBackups.slice(Config.MAX_BACKUPS_PER_ROOM)
			await Promise.all(
				filesToDelete.map((file) =>
					fs
						.unlink(path.join(Config.BACKUP_DIR, file))
						.catch((error) => {
							console.error(
								`Failed to delete backup ${file}:`,
								error,
							)
						}),
				),
			)
		} catch (error) {
			console.error(`Failed to cleanup old backups for ${roomId}:`, error)
		}
	}

	/**
	 * Gets all backup files for a room
	 * @param {number} roomId - The room ID
	 * @return {Promise<string[]>} Array of backup filenames
	 */
	async getAllBackups(roomId) {
		const sanitizedRoomId = this.sanitizeRoomId(roomId)
		const files = await fs.readdir(Config.BACKUP_DIR)
		return files
			.filter(
				(f) =>
					f.startsWith(`${sanitizedRoomId}_`) && f.endsWith('.bak'),
			)
			.sort()
			.reverse()
	}

	/**
	 * Recovers data from the latest backup
	 * @param {number} roomId - The room ID
	 * @return {Promise<object | null>} Recovered data or null if no backup exists
	 */
	async recoverFromBackup(roomId) {
		const backup = await this.getLatestBackup(roomId)
		if (!backup) {
			console.log(`No backup found for room ${roomId}`)
			return null
		}
		return backup.data
	}

	/**
	 * Checks if server data is newer than the latest backup
	 * @param {number} roomId - The room ID
	 * @param {object} serverData - Current server data
	 * @return {Promise<boolean>} True if server data is newer
	 */
	async isDataFresher(roomId, serverData) {
		const latestBackup = await this.getLatestBackup(roomId)

		if (!latestBackup) return true

		const serverTimestamp = serverData?.savedAt || 0
		const backupTimestamp = latestBackup.savedAt || 0

		return serverTimestamp >= backupTimestamp
	}

}
