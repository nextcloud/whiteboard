/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import RecordingService from './RecordingService.js'
import { checkPuppeteerAvailability } from '../Utilities/PuppeteerUtility.js'
import Config from '../Utilities/ConfigUtility.js'
import fetch from 'node-fetch'
import FormData from 'form-data'
import fs from 'fs'

// How often a stop forwarded to another node checks that node is still there
const FORWARDED_STOP_CHECK_MS = 5000

export default class RecordingControlService {

	constructor({
		cluster,
		sessionStore,
		io,
		nodeId,
		recordingServices,
	}) {
		this.cluster = cluster
		this.sessionStore = sessionStore
		this.io = io
		this.nodeId = nodeId
		this.recordingServices = recordingServices
	}

	#getRecordingKey(roomId, userId) {
		return `${roomId}_${userId}`
	}

	debugRecordingServices() {
		console.log('Active recording services:', Array.from(this.recordingServices.keys()))
		return this.recordingServices
	}

	async checkAvailability(socket) {
		try {
			const support = await checkPuppeteerAvailability({ force: false })
			socket.emit('recording-availability', {
				available: support.available,
				reason: support.reason || null,
			})
		} catch (error) {
			console.error('[Recording] Availability check failed:', error)
			socket.emit('recording-availability', {
				available: false,
				reason: 'Failed to check recording availability. Please try again later.',
			})
		}
	}

	async startRecording(socket, data) {
		const { fileId, recordingUrl, uploadToken, autoUploadOnDisconnect = false } = data
		const roomID = fileId.toString()
		const sessionKey = `${roomID}_${socket.id}`

		try {
			if (!Config.NEXTCLOUD_URL) {
				throw new Error('NEXTCLOUD_URL is not configured')
			}

			if (!URL.canParse(recordingUrl)) {
				throw new Error('Invalid recording URL')
			}

			const allowedOrigin = new URL(Config.NEXTCLOUD_URL).origin
			const recordingUrlParsed = new URL(recordingUrl)

			if (recordingUrlParsed.origin !== allowedOrigin) {
				throw new Error('Invalid recording URL: does not match configured NEXTCLOUD_URL')
			}

			if (recordingUrlParsed.searchParams.get('token') !== uploadToken) {
				throw new Error('Invalid recording URL: token mismatch')
			}

			if (!socket.rooms.has(roomID)) {
				throw new Error('Not joined to room')
			}

			const isReadOnly = await this.sessionStore.isReadOnly(socket.id)
			if (isReadOnly) {
				throw new Error('Read-only users cannot start recordings')
			}

			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			const existingRecording = await this.cluster.getRecordingEntry(roomID, socketData.user.id)
			if (existingRecording) {
				throw new Error('Recording already in progress')
			}

			const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
			if (this.recordingServices.has(recordingKey)) {
				throw new Error('Recording already in progress')
			}

			const recorder = new RecordingService()
			console.log(`[${sessionKey}] Initializing recording at ${recordingUrl}`)

			if (!await recorder.init(recordingUrl, roomID, socketData.user.id)) {
				throw new Error('Recorder initialization failed')
			}

			console.log(`[${sessionKey}] Starting recording`)
			await recorder.startRecording(roomID, socketData.user.id)
			const startedAt = Date.now()

			const username = socketData.user.displayName || socketData.user.name || 'Unknown User'
			this.recordingServices.set(recordingKey, {
				recorder,
				uploadToken,
				autoUploadOnDisconnect: Boolean(autoUploadOnDisconnect),
			})
			await this.cluster.setRecordingEntry(roomID, socketData.user.id, {
				userId: socketData.user.id,
				username,
				uploadToken,
				status: 'recording',
				nodeId: this.nodeId,
				startedAt,
			})

			socket.emit('recording-started', { startedAt })
			socket.to(roomID).emit('user-started-recording', {
				userId: socketData.user.id,
				username,
			})

		} catch (error) {
			console.error(`[${sessionKey}] Start recording failed:`, error)
			socket.emit('recording-error', error.message)
		}
	}

	/**
	 * Tell the tab that asked when the node it forwarded a stop to goes away
	 * before the recording ends. Encoding a long recording takes a while.
	 *
	 * @param {import('socket.io').Socket} socket The tab that asked
	 * @param {string} roomID The board
	 * @param {string} userId Whose recording it is
	 * @param {string} hostNodeId The node that records
	 */
	#watchForwardedStop(socket, roomID, userId, hostNodeId) {
		const timer = setInterval(async () => {
			try {
				// Reading drops the entry of a host that is gone
				const entry = await this.cluster.getRecordingEntry(roomID, userId)
				if (entry?.nodeId === hostNodeId) {
					return
				}
				clearInterval(timer)
				if (!entry && !(await this.cluster.isNodeAlive(hostNodeId))) {
					socket.emit('recording-error', 'Recording host unavailable, please try again')
				}
			} catch (error) {
				console.error(`[${roomID}_${userId}] Checking the recording host failed:`, error)
			}
		}, FORWARDED_STOP_CHECK_MS)
		socket.once('disconnect', () => clearInterval(timer))
	}

	// A writable tab of the user, preferably the one that asked
	async #findRecordingRecipient(roomID, userId, preferredSocketId) {
		let recipient = null
		for (const socket of await this.io.in(roomID).fetchSockets()) {
			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (socketData?.user?.id !== userId || socketData.clientType === 'recording' || await this.sessionStore.isReadOnly(socket.id)) {
				continue
			}
			if (socket.id === preferredSocketId) {
				return socket.id
			}
			recipient ??= socket.id
		}
		return recipient
	}

	async stopRecording(socket, roomID) {
		const sessionKey = `${roomID}_${socket.id}`
		try {
			if (!socket.rooms.has(roomID)) {
				throw new Error('Not joined to room')
			}

			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			const recordingKey = this.#getRecordingKey(roomID, socketData.user.id)
			console.log(`[${sessionKey}] Looking for recorder with key: ${recordingKey}`)
			const recordingService = this.recordingServices.get(recordingKey)
			const recordingEntry = await this.cluster.getRecordingEntry(roomID, socketData.user.id)

			if (!recordingService && recordingEntry?.nodeId && recordingEntry.nodeId !== this.nodeId) {
				console.log(`[${sessionKey}] Forwarding stop request to node ${recordingEntry.nodeId}`)
				const forwarded = await this.forwardRecordingStop(roomID, socketData.user.id, socket.id)
				if (!forwarded) {
					throw new Error('No active recording found')
				}
				this.#watchForwardedStop(socket, roomID, socketData.user.id, recordingEntry.nodeId)
				return
			}

			if (!recordingService) {
				console.log(`[${sessionKey}] Available recording keys:`, Array.from(this.recordingServices.keys()))
				await this.cluster.removeRecordingEntry(roomID, socketData.user.id)
				throw new Error('No active recording found')
			}

			const username = recordingEntry?.username
				|| socketData.user.displayName
				|| socketData.user.name
				|| 'Unknown User'

			console.log(`[${sessionKey}] Stopping recording locally on node ${this.nodeId}`)
			await this.finalizeRecordingStop({
				roomID,
				userId: socketData.user.id,
				username,
				recordingKey,
				recordingService,
				initiatorSocket: socket,
				requesterSocketId: socket.id,
			})
			console.log(`[${sessionKey}] Stop recording completed successfully`)

		} catch (error) {
			console.error(`[${sessionKey}] Stop recording failed:`, error)
			console.error(`[${sessionKey}] Error stack:`, error.stack)
			socket.emit('recording-error', error.message)
		}
	}

	async finalizeRecordingStop({
		roomID,
		userId,
		username,
		recordingKey,
		recordingService,
		initiatorSocket = null,
		requesterSocketId = null,
	}) {
		if (recordingService.stopping) {
			console.log(`[${roomID}_${userId}] Recording stop already in progress, skipping duplicate stop`)
			return
		}

		recordingService.stopping = true
		const { recorder, uploadToken } = recordingService
		try {
			const result = await recorder.stopRecording(roomID, userId)
			if (!result) {
				throw new Error('Failed to stop recording')
			}

			const payload = {
				filePath: result.localPath,
				recordingData: result.recordingData,
				uploadToken,
				fileId: roomID,
			}

			// The tab that asked may have closed while the video was encoded
			const preferredSocketId = initiatorSocket?.id ?? requesterSocketId
			const recipientSocketId = await this.#findRecordingRecipient(roomID, userId, preferredSocketId)
				.catch((error) => {
					console.warn(`[${roomID}_${userId}] Looking up the recording recipient failed:`, error)
					return recordingService.autoUploadOnDisconnect ? null : preferredSocketId
				})
			const shouldAutoUpload = !recipientSocketId && recordingService.autoUploadOnDisconnect
			let uploaded
			if (shouldAutoUpload) {
				try {
					await this.uploadRecordingToNextcloud({
						roomID,
						uploadToken,
						filePath: result.localPath,
						recordingData: result.recordingData,
					})
					uploaded = true
				} catch (error) {
					console.error(`[${roomID}_${userId}] Auto-upload on disconnect failed:`, error)
					uploaded = false
				}
			}

			if (recipientSocketId) {
				this.io.to(recipientSocketId).emit('recording-stopped', payload)
			} else if (uploaded !== undefined && preferredSocketId) {
				// The tab that asked may still be there, though the lookup could not tell
				this.io.to(preferredSocketId).emit('recording-stopped', { fileId: roomID, uploaded })
			}
			if (initiatorSocket) {
				initiatorSocket.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			} else {
				this.io.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			}

		} catch (error) {
			console.error(`[${roomID}_${userId}] Stop recording failed:`, error)
			if (initiatorSocket) {
				initiatorSocket.emit('recording-error', error.message)
			} else if (requesterSocketId) {
				this.io.to(requesterSocketId).emit('recording-error', error.message)
			}
		} finally {
			try {
				await recorder.cleanup(roomID, userId)
			} catch (error) {
				console.warn(`[${roomID}_${userId}] Cleanup failed after recording stop:`, error)
			}
			if (recordingKey && this.recordingServices.has(recordingKey)) {
				this.recordingServices.delete(recordingKey)
			}
			await this.cluster.removeRecordingEntry(roomID, userId)
		}
	}

	async uploadRecordingToNextcloud({ roomID, uploadToken, filePath, recordingData }) {
		if (!uploadToken) {
			throw new Error('Upload token missing for auto-upload')
		}
		if (!Config.NEXTCLOUD_URL) {
			throw new Error('NEXTCLOUD_URL is not configured for auto-upload')
		}

		const baseUrl = new URL(Config.NEXTCLOUD_URL)
		const basePath = baseUrl.pathname.replace(/\/$/, '')
		const uploadUrl = `${baseUrl.origin}${basePath}/index.php/apps/whiteboard/recording/${roomID}/upload`

		const formData = new FormData()
		let uploadBody
		if (filePath) {
			try {
				await fs.promises.access(filePath)
				uploadBody = fs.createReadStream(filePath)
			} catch (error) {
				console.warn(`[${roomID}] Auto-upload fallback to in-memory buffer:`, error)
			}
		}
		if (!uploadBody) {
			uploadBody = Buffer.from(recordingData)
		}
		formData.append('recording', uploadBody, {
			filename: 'recording.webm',
			contentType: 'video/webm',
		})

		const response = await fetch(uploadUrl, {
			method: 'POST',
			headers: {
				...formData.getHeaders(),
				Authorization: `Bearer ${uploadToken}`,
			},
			body: formData,
		})

		if (!response.ok) {
			const body = await response.text().catch(() => '')
			throw new Error(`Upload failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`)
		}

		console.log(`[${roomID}] Auto-upload on disconnect completed`)
		return response.json().catch(() => null)
	}

	async forwardRecordingStop(roomID, userId, requesterSocketId) {
		if (!this.io?.serverSideEmit) {
			return false
		}
		this.io.serverSideEmit('recording-stop-request', {
			roomID,
			userId,
			requesterSocketId,
		})
		return true
	}

}
