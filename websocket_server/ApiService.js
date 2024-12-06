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

	async saveRoomDataToServer(roomID, roomData, lastEditedUser, files) {
		console.log(`[${roomID}] Saving room data to server: ${roomData.length} elements, ${Object.keys(files).length} files`)

		const url = `${this.NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`

		const body = {
			data: {
				type: 'excalidraw',
				elements: roomData,
				files: this.cleanupFiles(roomData, files),
				savedAt: Date.now(),
			},
		}

		const options = this.fetchOptions('PUT', null, body, roomID, lastEditedUser)

		return this.fetchData(url, options)
	}

	cleanupFiles(elements, files) {
		const elementFileIds = elements.filter(e => e?.fileId && e?.isDeleted !== true).map((e) => e.fileId)
		const fileIds = Object.keys(files)

		const fileIdsToStore = fileIds.filter((fileId) => elementFileIds.includes(fileId))
		const filesToStore = fileIdsToStore.reduce((acc, fileId) => {
			acc[fileId] = files[fileId]
			return acc
		}, {})
		return filesToStore
	}

}
