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
		this.lastSavedAt = Date.now()
		this.files = files
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

	updateLastSavedAt() {
		this.lastSavedAt = Date.now()
	}

	getLastSavedAt() {
		return this.lastSavedAt
	}

	toJSON() {
		return {
			id: this.id,
			data: this.data,
			users: Array.from(this.users),
			lastEditedUser: this.lastEditedUser,
			lastSavedAt: this.lastSavedAt,
			files: this.files,
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
		room.lastSavedAt = json.lastSavedAt
		return room
	}

}
