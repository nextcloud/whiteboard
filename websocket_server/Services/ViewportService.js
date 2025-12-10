/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import GeneralUtility from '../Utilities/GeneralUtility.js'

export default class ViewportService {

	constructor({
		io,
		sessionStore,
	}) {
		this.io = io
		this.sessionStore = sessionStore
	}

	async serverBroadcast(socket, roomID, encryptedData, iv) {
		const isReadOnly = await this.sessionStore.isReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)
	}

	async serverVolatileBroadcast(socket, roomID, encryptedData) {
		const payload = JSON.parse(
			GeneralUtility.convertArrayBufferToString(encryptedData),
		)

		if (payload.type === 'MOUSE_LOCATION') {
			const socketData = await this.sessionStore.getSocketData(socket.id)

			if (!socketData) return

			const eventData = {
				type: 'MOUSE_LOCATION',
				payload: {
					...payload.payload,
					user: socketData.user,
				},
			}

			socket.volatile.broadcast
				.to(roomID)
				.emit(
					'client-broadcast',
					GeneralUtility.convertStringToArrayBuffer(JSON.stringify(eventData)),
				)
		} else if (payload.type === 'VIEWPORT_UPDATE') {
			const socketData = await this.sessionStore.getSocketData(socket.id)

			if (!socketData) return

			const eventData = {
				type: 'VIEWPORT_UPDATE',
				payload: {
					...payload.payload,
					userId: socketData.user.id,
				},
			}

			console.log(`[${roomID}] Broadcasting viewport update from user ${socketData.user.id}:`, eventData.payload)

			socket.volatile.broadcast
				.to(roomID)
				.emit(
					'client-broadcast',
					GeneralUtility.convertStringToArrayBuffer(JSON.stringify(eventData)),
				)
		}
	}

	async imageGet(socket, roomId, id) {
		if (!socket.rooms.has(roomId)) return

		try {
			console.log(`[${roomId}] ${socket.id} requested image ${id}`)

			const requestData = {
				type: 'IMAGE_REQUEST',
				payload: { fileId: id },
			}

			socket.to(roomId).emit('client-broadcast',
				GeneralUtility.convertStringToArrayBuffer(JSON.stringify(requestData)))
		} catch (error) {
			console.error(`[${roomId}] Error handling image request ${id}:`, error)
		}
	}

	async requestViewport(socket, data) {
		const { fileId, userId } = data
		const roomID = fileId

		try {
			const socketData = await this.sessionStore.getSocketData(socket.id)
			if (!socketData?.user?.id) {
				console.warn(`[${roomID}] Invalid socket data for viewport request`)
				return
			}

			console.log(`[${roomID}] User ${socketData.user.id} requesting viewport from user ${userId}`)

			const userSockets = await this.getUserSocketsInRoom(roomID)
			const targetSockets = userSockets.filter(s => s.userId === userId)

			if (targetSockets.length > 0) {
				const targetSocketId = targetSockets[0].socketId
				const targetSocket = this.io.sockets.sockets.get(targetSocketId)

				if (targetSocket) {
					console.log(`[${roomID}] Requesting viewport from socket ${targetSocketId}`)
					targetSocket.emit('send-viewport-request', {
						requesterId: socketData.user.id,
						requesterSocketId: socket.id,
					})
				} else {
					console.warn(`[${roomID}] Target socket ${targetSocketId} not found`)
				}
			} else {
				console.warn(`[${roomID}] User ${userId} not found in room`)
			}
		} catch (error) {
			console.error(`[${roomID}] Error handling viewport request:`, error)
		}
	}

	async getUserSocketsInRoom(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(
			sockets.map(async (s) => {
				const data = await this.sessionStore.getSocketData(s.id)
				if (!data?.user?.id) {
					console.warn(`Invalid socket data for socket ${s.id}`)
					return null
				}
				return {
					socketId: s.id,
					userId: data.user.id,
					userName: data.user.name,
				}
			}),
		).then((results) => results.filter(Boolean))
	}

}
