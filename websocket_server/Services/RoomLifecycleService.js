/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import GeneralUtility from '../Utilities/GeneralUtility.js'

export default class RoomLifecycleService {

	constructor({
		io,
		sessionStore,
		cluster,
		presentationState,
		recordingState,
		timerService = null,
		votingService = null,
	}) {
		this.io = io
		this.sessionStore = sessionStore
		this.cluster = cluster
		this.presentationState = presentationState
		this.recordingState = recordingState
		this.timerService = timerService
		this.votingService = votingService
	}

	async joinRoom(socket, roomID) {
		const validatedRoomId = GeneralUtility.validateRoomId(roomID)
		if (!validatedRoomId) {
			console.warn(`[SECURITY] Invalid room ID format rejected: ${String(roomID).substring(0, 100)}`)
			return false
		}

		const socketData = await this.sessionStore.getSocketData(socket.id)
		if (!socketData || !socketData.user) {
			console.warn(`[${validatedRoomId}] Invalid socket data for socket ${socket.id}, rejecting join`)
			return false
		}

		const roomClaims = [socketData.fileId, socketData.roomID]
			.filter((claim) => claim !== null && claim !== undefined)
		const isAuthorizedRoom = roomClaims.length > 0
			&& roomClaims.every((claim) => GeneralUtility.validateRoomId(claim) === validatedRoomId)
		if (!isAuthorizedRoom) {
			console.warn(`[SECURITY] Socket ${socket.id} rejected from unauthorized room ${validatedRoomId}`)
			return false
		}

		const userId = socketData.user.id
		const userName = socketData.user.name

		if (socket.rooms.has(validatedRoomId)) {
			console.log(`[${validatedRoomId}] ${userName} already in room, skipping join`)
			return true
		}

		console.log(`[${validatedRoomId}] ${userName} joined room`)

		await socket.join(validatedRoomId)

		let currentSyncer = await this.cluster.getRoomSyncer(validatedRoomId)
		let goneSyncer = null
		if (currentSyncer && await this.isSyncerGone(validatedRoomId, currentSyncer, socketData)) {
			goneSyncer = currentSyncer
			currentSyncer = null
		}

		let isSyncer = currentSyncer?.socketId === socket.id
		if (!currentSyncer) {
			if (await this.canSync(socket.id, socketData)) {
				if (goneSyncer) {
					await this.cluster.releaseRoomSyncer(validatedRoomId, goneSyncer)
				}
				const syncer = { userId, socketId: socket.id, nodeId: socketData.nodeId }
				isSyncer = await this.cluster.trySetRoomSyncer(validatedRoomId, syncer)
				// The socket can leave while it joins; its leave handling then did not find it in the record
				if (isSyncer && !socket.connected) {
					await this.findNewSyncer(validatedRoomId, syncer)
					return false
				}
			} else {
				await this.findNewSyncer(validatedRoomId, goneSyncer)
			}
		}

		await this.sessionStore.setSocketData(socket.id, {
			...socketData,
			isSyncer,
			...(isSyncer ? { syncerFor: validatedRoomId } : {}),
		})
		socket.emit('sync-designate', { isSyncer })
		// The room can elect this socket while it joins, and tell it before the line above
		if (!isSyncer && (await this.cluster.getRoomSyncer(validatedRoomId))?.socketId === socket.id) {
			isSyncer = true
			socket.emit('sync-designate', { isSyncer })
		}
		if (isSyncer) {
			console.log(`[${validatedRoomId}] Designated syncer: ${userName}`)
		}

		const roomUsers = await this.getUserSocketsAndIds(validatedRoomId)

		console.log(`[${validatedRoomId}] Room now has ${roomUsers.length} users`)

		if (roomUsers.length > 0) {
			this.io.to(validatedRoomId).emit('room-user-change', roomUsers)
		}

		this.io.to(validatedRoomId).emit('user-joined', {
			userId,
			userName,
			socketId: socket.id,
			isSyncer,
		})

		const presentationSession = await this.presentationState.getPresentationSession(validatedRoomId)
		if (presentationSession) {
			console.log(`[${validatedRoomId}] Notifying new user ${userName} about active presentation by ${presentationSession.presenterName}`)
			socket.emit('user-started-presenting', {
				userId: presentationSession.presenterId,
				username: presentationSession.presenterName,
			})
		}

		const recordingState = await this.recordingState.getRecordingState(validatedRoomId)
		Object.values(recordingState).forEach((entry) => {
			if (!entry) {
				return
			}
			const isSelf = entry.userId === userId
			const startedAt = entry.startedAt || Date.now()

			if (isSelf) {
				socket.emit('recording-started', {
					startedAt,
					resumed: true,
				})
			}

			socket.emit('user-started-recording', {
				userId: entry.userId,
				username: entry.username,
				startedAt,
				resumed: isSelf,
			})
		})

		if (this.timerService) {
			await this.timerService.hydrateForSocket(validatedRoomId, socket)
		}

		if (this.votingService) {
			await this.votingService.hydrateForSocket(validatedRoomId, socket)
		}

		return true
	}

	async onDisconnecting(socket, rooms, { shuttingDown = false } = {}) {
		if (shuttingDown) {
			return
		}
		for (const roomID of rooms) {
			if (roomID === socket.id) continue

			const socketData = await this.sessionStore.getSocketData(socket.id)
			const userId = socketData?.user?.id
			const userName = socketData?.user?.name || 'Unknown'

			console.log(`[${roomID}] User ${userName} disconnecting`)

			const currentSyncer = await this.cluster.getRoomSyncer(roomID)
			if (currentSyncer?.socketId === socket.id) {
				console.log(`[${roomID}] Syncer disconnected, finding new syncer`)
				await this.findNewSyncer(roomID, currentSyncer)
			}

			const presentationSession = await this.presentationState.getPresentationSession(roomID)
			if (presentationSession) {
				const isPublicSharingUser = typeof userId === 'string' && userId.startsWith('shared_')
				let shouldEndPresentation = false

				if (presentationSession.presenterId === userId) {
					shouldEndPresentation = true
				} else if (isPublicSharingUser && typeof presentationSession.presenterId === 'string') {
					const userTokenPart = userId.split('_')[1]
					const presenterTokenPart = presentationSession.presenterId.split('_')[1]
					if (userTokenPart === presenterTokenPart) {
						shouldEndPresentation = true
					}
				}

				if (shouldEndPresentation) {
					const roomSockets = await this.getUserSocketsInRoom(roomID)
					const presenterStillConnected = roomSockets
						.filter(Boolean)
						.some((s) => s.userId === presentationSession.presenterId && s.socketId !== socket.id)

					if (presenterStillConnected) {
						console.log(`[${roomID}] Presenter still connected on another socket, skipping presentation end`)
					} else {
						console.log(`[${roomID}] Presenter ${userName} disconnected, ending presentation`)
						await this.presentationState.clearPresentationSession(roomID)

						socket.to(roomID).emit('user-stopped-presenting', {
							userId,
							username: userName,
						})
					}
				}
			}

			const roomUsers = await this.getUserSocketsAndIds(roomID)
			socket.to(roomID).emit('room-user-change', roomUsers)
		}
	}

	// A record without a socket comes from a relay that elected a whole user.
	// A tab that reconnects names its old socket, which may not have timed out yet.
	// A socket whose leave handling did not run is no longer in the room.
	async isSyncerGone(roomID, syncer, socketData) {
		if (!syncer.socketId) {
			return true
		}
		if (syncer.socketId === socketData.previousSocketId && syncer.userId === socketData.user.id) {
			return true
		}
		return !(await this.isSocketInRoom(roomID, syncer.socketId))
	}

	// A lookup that fails counts as present: a slow relay says nothing about the socket
	async isSocketInRoom(roomID, socketId) {
		const localSocket = this.io.sockets?.sockets.get(socketId)
		if (localSocket) {
			return localSocket.rooms.has(roomID)
		}
		try {
			const [remoteSocket] = await this.io.in(socketId).fetchSockets()
			return Boolean(remoteSocket?.rooms.has(roomID))
		} catch (error) {
			console.warn(`[${roomID}] Could not look up socket ${socketId}: ${error.message}`)
			return true
		}
	}

	// Recording clients render the board for a recording, and version previews do not save
	async canSync(socketId, socketData) {
		return !['recording', 'preview'].includes(socketData?.clientType) && !(await this.sessionStore.isReadOnly(socketId))
	}

	// The previous record is released only once the room could be read, so a failed election is tried again
	async findNewSyncer(roomID, previousSyncer = null) {
		const roomSockets = await this.getUserSocketsInRoom(roomID)
		if (previousSyncer) {
			await this.cluster.releaseRoomSyncer(roomID, previousSyncer)
		}

		console.log(`[${roomID}] Finding new syncer. Sockets in room: ${roomSockets.length}`)

		if (roomSockets.length === 0) {
			console.log(`[${roomID}] No users left in room, no syncer needed`)
			return
		}

		for (const { socketId, userId, userName } of roomSockets) {
			const socketData = await this.sessionStore.getSocketData(socketId)
			if (!socketData || !await this.canSync(socketId, socketData)) {
				continue
			}

			const syncer = { userId, socketId, nodeId: socketData.nodeId }
			// Fails when another socket took the free slot meanwhile; that socket stays the syncer
			if (!await this.cluster.trySetRoomSyncer(roomID, syncer)) {
				return
			}
			// A socket that left after the room was read did not find itself in the record
			if (!await this.isSocketInRoom(roomID, socketId)) {
				await this.cluster.releaseRoomSyncer(roomID, syncer)
				continue
			}

			await this.sessionStore.setSocketData(socketId, {
				...socketData,
				isSyncer: true,
				syncerFor: roomID,
			})
			this.io.to(socketId).emit('sync-designate', { isSyncer: true })
			console.log(`[${roomID}] Promoted new syncer: ${userName}`)
			return
		}

		console.log(`[${roomID}] No eligible users found for syncer role`)
	}

	async getUserSocketsAndIds(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()

		console.log(`[${roomID}] Fetched ${sockets.length} sockets for room-user-change event`)

		const socketResults = await Promise.all(
			sockets.map(async (s) => {
				const data = await this.sessionStore.getSocketData(s.id)
				if (!data?.user?.id) {
					console.warn(`Invalid socket data for socket ${s.id}`)
					return null
				}
				return {
					socketId: s.id,
					user: data.user,
					userId: data.user.id,
				}
			}),
		)

		const validSockets = socketResults.filter(Boolean)

		const userMap = new Map()
		validSockets.forEach((socketData) => {
			const existingUser = userMap.get(socketData.userId)
			if (existingUser) {
				existingUser.socketIds.push(socketData.socketId)
			} else {
				userMap.set(socketData.userId, {
					socketId: socketData.socketId,
					user: socketData.user,
					userId: socketData.userId,
					socketIds: [socketData.socketId],
				})
			}
		})

		const deduplicatedUsers = Array.from(userMap.values())

		console.log(`[${roomID}] Returning ${deduplicatedUsers.length} unique users (from ${validSockets.length} sockets) for room-user-change event`)

		return deduplicatedUsers
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
					clientType: data.clientType,
				}
			}),
		).then((results) => results.filter(Boolean))
	}

}
