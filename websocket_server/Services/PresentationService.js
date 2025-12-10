/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

export default class PresentationService {

	constructor({
		cluster,
		sessionStore,
		io,
		nodeId,
	}) {
		this.cluster = cluster
		this.sessionStore = sessionStore
		this.io = io
		this.nodeId = nodeId
	}

	async getPresentationSession(roomID) {
		return this.cluster.getPresentation(roomID)
	}

	async setPresentationSession(roomID, session) {
		return this.cluster.setPresentation(roomID, session)
	}

	async clearPresentationSession(roomID) {
		return this.cluster.clearPresentation(roomID)
	}

	async start(socket, data) {
		const { fileId, userId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			const socketUserId = socketData.user.id
			const isPublicSharingUser = socketUserId.startsWith('shared_')

			console.log(`[${sessionKey}] User ID validation:`, {
				socketUserId,
				requestUserId: userId,
				isPublicSharingUser,
				match: socketUserId === userId,
			})

			let authoritativeUserId = userId
			if (socketUserId !== userId) {
				if (!isPublicSharingUser) {
					throw new Error('User ID mismatch')
				}

				console.log(`[${sessionKey}] Using socket user ID for public sharing user: ${socketUserId}`)
				authoritativeUserId = socketUserId
			}

			const existingSession = await this.getPresentationSession(roomID)
			if (existingSession) {
				if (existingSession.presenterId === authoritativeUserId) {
					console.log(`[${sessionKey}] User ${socketData.user.displayName} restarting their presentation`)
					existingSession.startTime = Date.now()
					await this.setPresentationSession(roomID, existingSession)

					socket.emit('presentation-started')
					return
				} else {
					throw new Error(`Presentation already in progress by ${existingSession.presenterName}`)
				}
			}

			const presenterName = socketData.user.displayName || socketData.user.name || 'Unknown User'
			const presentationSession = {
				presenterId: authoritativeUserId,
				presenterName,
				startTime: Date.now(),
			}

			console.log(`[${sessionKey}] Creating presentation session:`, presentationSession)

			await this.setPresentationSession(roomID, {
				...presentationSession,
				nodeId: this.nodeId,
			})
			console.log(`[${sessionKey}] Started presentation by ${presenterName}`)

			console.log(`[${sessionKey}] Emitting presentation-started to presenter`)
			socket.emit('presentation-started')

			console.log(`[${sessionKey}] Emitting user-started-presenting to room ${roomID}`)
			socket.to(roomID).emit('user-started-presenting', {
				userId: authoritativeUserId,
				username: presenterName,
			})

			console.log(`[${sessionKey}] Notified room about presentation start`)

		} catch (error) {
			console.error(`[${sessionKey}] Start presentation failed:`, error)
			socket.emit('presentation-error', error.message)
		}
	}

	async stop(socket, data) {
		const { fileId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (!socketData?.user?.id) throw new Error('Unauthorized')

			const presentationSession = await this.getPresentationSession(roomID)
			if (!presentationSession) {
				throw new Error('No active presentation found')
			}

			const socketUserId = socketData.user.id
			const isPublicSharingUser = socketUserId.startsWith('shared_')

			console.log(`[${sessionKey}] Stop presentation validation:`, {
				socketUserId,
				presenterId: presentationSession.presenterId,
				isPublicSharingUser,
				match: presentationSession.presenterId === socketUserId,
			})

			if (presentationSession.presenterId !== socketUserId) {
				if (!isPublicSharingUser) {
					throw new Error('Only the presenter can stop the presentation')
				}

				const socketTokenPart = socketUserId.split('_')[1]
				const presenterTokenPart = presentationSession.presenterId.split('_')[1]

				if (socketTokenPart !== presenterTokenPart) {
					throw new Error('Only the presenter can stop the presentation')
				}

				console.log(`[${sessionKey}] Allowing public sharing user to stop presentation (same token)`)
			}

			const presenterName = socketData.user.displayName || socketData.user.name || 'Unknown User'
			await this.clearPresentationSession(roomID)
			console.log(`[${sessionKey}] Stopped presentation by ${presenterName}`)

			socket.emit('presentation-stopped')

			socket.to(roomID).emit('user-stopped-presenting', {
				userId: socketData.user.id,
				username: presenterName,
			})

			console.log(`[${sessionKey}] Notified room about presentation stop`)

		} catch (error) {
			console.error(`[${sessionKey}] Stop presentation failed:`, error)
			socket.emit('presentation-error', error.message)
		}
	}

	async requestPresenterViewport(socket, data) {
		const { fileId } = data
		const roomID = fileId
		const sessionKey = `${roomID}_${socket.id}`

		try {
			console.log(`[${sessionKey}] Presenter viewport requested`)

			const presentationSession = await this.getPresentationSession(roomID)
			if (!presentationSession) {
				console.log(`[${sessionKey}] No active presentation found`)
				return
			}

			this.io.to(roomID).emit('request-presenter-viewport')

			console.log(`[${sessionKey}] Broadcast presenter viewport request to room ${roomID}`)
		} catch (error) {
			console.error(`[${sessionKey}] Request presenter viewport failed:`, error)
		}
	}

}
