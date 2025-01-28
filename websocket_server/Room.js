/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class Room {

	constructor(id, data = null, users = new Set(), lastEditedUser = null, files = {}) {
		this.id = id
		this.data = data
		this.users = new Set(users)
		this.lastEditedUser = lastEditedUser
		this.files = files
		// Map to store recording users and their recording info
		this.recordingUsers = new Map()
	}

	setUsers(users) {
		this.users = new Set(users)
	}

	updateLastEditedUser(userId) {
		this.lastEditedUser = userId
	}

	setData(data) {
		this.data = data
	}

	setFiles(files) {
		this.files = files
	}

	getFiles() {
		return this.files
	}

	addFile(id, file) {
		this.files[id] = file
	}

	removeFile(id) {
		delete this.files[id]
	}

	getFile(id) {
		return this.files[id] ?? undefined
	}

	isEmpty() {
		return this.users.size === 0
	}

	isReadyForRecording() {
		// Only check for active users, don't require content
		return this.users.size > 0
	}

	addRecordingUser(userId) {
		this.recordingUsers.set(userId, {
			startTime: Date.now(),
			filePath: null,
		})
	}

	removeRecordingUser(userId) {
		this.recordingUsers.delete(userId)
	}

	setRecordingFilePath(userId, filePath) {
		const userRecording = this.recordingUsers.get(userId)
		if (userRecording) {
			userRecording.filePath = filePath
			this.recordingUsers.set(userId, userRecording)
		}
	}

	isUserRecording(userId) {
		return this.recordingUsers.has(userId)
	}

	getRecordingUsers() {
		return Array.from(this.recordingUsers.keys())
	}

	getRecordingStatus(userId) {
		const userRecording = this.recordingUsers.get(userId)
		return userRecording
			? {
				isRecording: true,
				startTime: userRecording.startTime,
				filePath: userRecording.filePath,
			}
			: {
				isRecording: false,
				startTime: null,
				filePath: null,
			}
	}

	toJSON() {
		return {
			id: this.id,
			data: this.data,
			users: Array.from(this.users),
			lastEditedUser: this.lastEditedUser,
			files: this.files,
			recordingUsers: Array.from(this.recordingUsers.entries()).map(([userId, data]) => ({
				userId,
				...data,
			})),
		}
	}

	static fromJSON(json) {
		const room = new Room(
			json.id,
			json.data,
			new Set(json.users),
			json.lastEditedUser,
			json.files,
		)

		// Restore recording users
		if (json.recordingUsers) {
			json.recordingUsers.forEach(({ userId, startTime, filePath }) => {
				room.recordingUsers.set(userId, {
					startTime,
					filePath,
				})
			})
		}

		return room
	}

}
