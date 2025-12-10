/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import RecordingService from './RecordingService.js'
import { checkPuppeteerAvailability } from '../Utilities/PuppeteerUtility.js'

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
		const { fileId, recordingUrl, uploadToken } = data
		const roomID = fileId.toString()
		const sessionKey = `${roomID}_${socket.id}`

		try {
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

			this.recordingServices.set(recordingKey, { recorder, uploadToken })
			await this.cluster.setRecordingEntry(roomID, socketData.user.id, {
				userId: socketData.user.id,
				username: socketData.user.displayName || socketData.user.name || 'Unknown User',
				uploadToken,
				status: 'recording',
				nodeId: this.nodeId,
				startedAt: Date.now(),
			})

			socket.emit('recording-started')
			socket.to(roomID).emit('user-started-recording', {
				userId: socketData.user.id,
				username: socketData.user.displayName,
			})

		} catch (error) {
			console.error(`[${sessionKey}] Start recording failed:`, error)
			socket.emit('recording-error', error.message)
		}
	}

	async stopRecording(socket, roomID) {
		const sessionKey = `${roomID}_${socket.id}`
		try {
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
				setTimeout(async () => {
					try {
						const latestEntry = await this.cluster.getRecordingEntry(roomID, socketData.user.id)
						if (latestEntry && latestEntry.nodeId === recordingEntry.nodeId) {
							await this.cluster.removeRecordingEntry(roomID, socketData.user.id)
							socket.emit('recording-error', 'Recording host unavailable, please try again')
						}
					} catch (err) {
						console.error(`[${sessionKey}] Failed to clear stale recording entry:`, err)
					}
				}, 3000)
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
		const { recorder, uploadToken } = recordingService
		try {
			const result = await recorder.stopRecording(roomID, userId)
			if (!result) {
				throw new Error('Failed to stop recording')
			}

			await recorder.cleanup(roomID, userId)

			const payload = {
				filePath: result.localPath,
				recordingData: result.recordingData,
				uploadToken,
				fileId: roomID,
			}

			if (initiatorSocket) {
				initiatorSocket.emit('recording-stopped', payload)
				initiatorSocket.to(roomID).emit('user-stopped-recording', {
					userId,
					username,
				})
			} else if (requesterSocketId) {
				this.io.to(requesterSocketId).emit('recording-stopped', payload)
				this.io.to(roomID).emit('user-stopped-recording', {
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
			if (recordingKey && this.recordingServices.has(recordingKey)) {
				this.recordingServices.delete(recordingKey)
			}
			await this.cluster.removeRecordingEntry(roomID, userId)
		}
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
