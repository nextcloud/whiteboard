/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fetch from 'node-fetch'
import https from 'https'
import Config from './Config.js'

export default class ApiService {

	constructor(tokenGenerator) {
		this.agent = (Config.USE_TLS) ? new https.Agent({ rejectUnauthorized: !Config.BYPASS_SSL_VALIDATION }) : null
		this.tokenGenerator = tokenGenerator
		console.log('[DEBUG] ApiService initialized', {
			use_tls: Config.USE_TLS,
			bypass_ssl: Config.BYPASS_SSL_VALIDATION,
			nextcloud_url: Config.NEXTCLOUD_URL,
		})
	}

	fetchOptions(method, token, body = null, roomId = null, lastEditedUser = null) {
		const options = {
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

		// Log options but hide full token values
		const logSafeOptions = {
			...options,
			headers: { ...options.headers },
		}

		if (logSafeOptions.headers.Authorization) {
			const tokenPart = token.substring(0, 10) + '...' + token.substring(token.length - 5)
			logSafeOptions.headers.Authorization = `Bearer ${tokenPart}`
		}

		if (logSafeOptions.headers['X-Whiteboard-Auth']) {
			const authToken = logSafeOptions.headers['X-Whiteboard-Auth']
			logSafeOptions.headers['X-Whiteboard-Auth'] = authToken.substring(0, 10) + '...' + authToken.substring(authToken.length - 5)
		}

		console.log(`[DEBUG] Request options for ${method} request:`, logSafeOptions)

		return options
	}

	async fetchData(url, options) {
		try {
			console.log(`[DEBUG] API request: ${options.method} ${url}`)

			const startTime = Date.now()
			const response = await fetch(url, options)
			const responseTime = Date.now() - startTime

			console.log(`[DEBUG] Response received in ${responseTime}ms, status: ${response.status}`)

			if (!response.ok) {
				const errorText = await response.text()
				console.error(`[ERROR] API request failed: ${options.method} ${url}`)
				console.error(`[ERROR] Status: ${response.status}, Response: ${errorText}`)
				throw new Error(`HTTP error! status: ${response.status}: ${errorText}`)
			}

			const data = await response.json()
			console.log(`[DEBUG] API request successful: ${options.method} ${url}`)
			return data
		} catch (error) {
			console.error(`[ERROR] Exception in fetchData: ${error.message}`)
			if (error.stack) {
				console.error(`[ERROR] Stack trace: ${error.stack}`)
			}
			return null
		}
	}

	async getRoomDataFromServer(roomID, jwtToken) {
		console.log(`[DEBUG] Getting room data for room: ${roomID}`)
		const url = `${Config.NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`
		const options = this.fetchOptions('GET', jwtToken)

		try {
			const result = await this.fetchData(url, options)
			if (result) {
				console.log(`[DEBUG] Successfully retrieved room data for ${roomID}:`, {
					elements_count: result.data?.elements?.length || 0,
					files_count: result.data?.files ? Object.keys(result.data.files).length : 0,
				})
			} else {
				console.error(`[ERROR] Failed to retrieve room data for ${roomID}`)
			}
			return result
		} catch (error) {
			console.error(`[ERROR] getRoomDataFromServer failed for room ${roomID}: ${error.message}`)
			throw error
		}
	}

	async saveRoomDataToServer(roomID, roomData, lastEditedUser, files) {
		console.log(`[${roomID}] Saving room data to server: ${roomData.length} elements, ${Object.keys(files).length} files`)

		const url = `${Config.NEXTCLOUD_URL}/index.php/apps/whiteboard/${roomID}`

		const body = {
			data: {
				type: 'excalidraw',
				elements: roomData,
				files: this.cleanupFiles(roomData, files),
				savedAt: Date.now(),
			},
		}

		console.log('[DEBUG] Save request details:', {
			room_id: roomID,
			elements_count: roomData.length,
			files_before_cleanup: Object.keys(files).length,
			files_after_cleanup: Object.keys(body.data.files).length,
			last_edited_user: lastEditedUser,
		})

		const options = this.fetchOptions('PUT', null, body, roomID, lastEditedUser)

		try {
			const result = await this.fetchData(url, options)
			if (result) {
				console.log(`[DEBUG] Successfully saved room data for ${roomID}`, {
					status: result.status || 'unknown',
				})
			} else {
				console.error(`[ERROR] Failed to save room data for ${roomID}`)
			}
			return result
		} catch (error) {
			console.error(`[ERROR] saveRoomDataToServer failed for room ${roomID}: ${error.message}`)
			throw error
		}
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
