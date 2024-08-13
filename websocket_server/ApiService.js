/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fetch from 'node-fetch'
import https from 'https'
import dotenv from 'dotenv'
import Utils from './Utils.js'
dotenv.config()

export default class ApiService {

	constructor(tokenGenerator) {
		this.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL
		this.IS_DEV = Utils.parseBooleanFromEnv(process.env.IS_DEV)
		this.agent = this.IS_DEV ? new https.Agent({ rejectUnauthorized: false }) : null
		this.tokenGenerator = tokenGenerator
	}

	fetchOptions(method, token, body = null, roomId = null, lastEditedUser = null) {
		return {
			method,
			headers: {
				'Content-Type': 'application/json',
				...(method === 'GET' && { Authorization: `Bearer ${token}` }),
				...(method === 'PUT' && {
					'X-Whiteboard-Auth': this.tokenGenerator.handle(roomId),
					'X-Whiteboard-User': lastEditedUser || 'unknown',
				}),
			},
			...(body && { body: JSON.stringify(body) }),
			...(this.agent && { agent: this.agent }),
		}
	}

	async fetchData(url, options) {
		try {
			const response = await fetch(url, options)
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}: ${await response.text()}`)
			}
			return response.json()
		} catch (error) {
			console.error(error)
			return null
		}
	}

	async getRoomDataFromServer(roomID, jwtToken) {
		const url = `${this.NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
		const options = this.fetchOptions('GET', jwtToken)
		return this.fetchData(url, options)
	}

	async saveRoomDataToServer(roomID, roomData, lastEditedUser) {
		console.log('Saving room data to file')

		const url = `${this.NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
		const body = { data: { elements: roomData } }
		const options = this.fetchOptions('PUT', null, body, roomID, lastEditedUser)
		return this.fetchData(url, options)
	}

}
