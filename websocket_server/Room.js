/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class Room {

	constructor(id, data = null, users = new Set(), lastEditedUser = null) {
		this.id = id
		this.data = data
		this.users = new Set(users)
		this.lastEditedUser = lastEditedUser
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

	isEmpty() {
		return this.users.size === 0
	}

	toJSON() {
		return {
			id: this.id,
			data: this.data,
			users: Array.from(this.users),
			lastEditedUser: this.lastEditedUser,
		}
	}

	static fromJSON(json) {
		return new Room(
			json.id,
			json.data,
			new Set(json.users),
			json.lastEditedUser,
		)
	}

}
