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
			return
		}

		const socketData = await this.sessionStore.getSocketData(socket.id)
		if (!socketData || !socketData.user) {
			console.warn(`[${validatedRoomId}] Invalid socket data for socket ${socket.id}, rejecting join`)
			return
		}

		const userId = socketData.user.id
		const userName = socketData.user.name

		if (socket.rooms.has(validatedRoomId)) {
			console.log(`[${validatedRoomId}] ${userName} already in room, skipping join`)
			return
		}

		console.log(`[${validatedRoomId}] ${userName} joined room`)

		await socket.join(validatedRoomId)

		const currentSyncer = await this.cluster.getRoomSyncer(validatedRoomId)
		let currentSyncerUserId = currentSyncer?.userId
		if (currentSyncer?.nodeId && !(await this.cluster.isNodeAlive(currentSyncer.nodeId))) {
			await this.cluster.clearRoomSyncer(validatedRoomId)
			currentSyncerUserId = null
		}
		const isReadOnly = await this.sessionStore.isReadOnly(socket.id)

		let isSyncer = false

		if (currentSyncerUserId === userId) {
			await this.sessionStore.setSocketData(socket.id, {
				...socketData,
				isSyncer: true,
				syncerFor: validatedRoomId,
			})

			isSyncer = true
			socket.emit('sync-designate', { isSyncer: true })
			console.log(`[${validatedRoomId}] User ${userName} reconnected as existing syncer`)
		} else if (!currentSyncerUserId && !isReadOnly) {
			const elected = await this.cluster.trySetRoomSyncer(validatedRoomId, userId)

			if (elected) {
				await this.sessionStore.setSocketData(socket.id, {
					...socketData,
					isSyncer: true,
					syncerFor: validatedRoomId,
				})

				isSyncer = true
				socket.emit('sync-designate', { isSyncer: true })
				console.log(`[${validatedRoomId}] Designated new syncer: ${userName}`)
			} else {
				await this.sessionStore.setSocketData(socket.id, {
					...socketData,
					isSyncer: false,
				})

				isSyncer = false
				socket.emit('sync-designate', { isSyncer: false })
				console.log(`[${validatedRoomId}] User ${userName} lost syncer election (another user won)`)
			}
		} else {
			await this.sessionStore.setSocketData(socket.id, {
				...socketData,
				isSyncer: false,
			})

			isSyncer = false
			socket.emit('sync-designate', { isSyncer: false })
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
			const currentSyncerUserId = currentSyncer?.userId
			const wasSyncer = currentSyncerUserId === userId

			if (wasSyncer) {
				const userSockets = await this.getUserSocketsInRoom(roomID)
				const userStillConnected = userSockets
					.filter((s) => s.socketId !== socket.id)
					.some((s) => s.userId === userId)

				if (!userStillConnected) {
					console.log(`[${roomID}] Syncer disconnected (all sessions), finding new syncer`)
					await this.findNewSyncer(roomID)
				} else {
					console.log(`[${roomID}] Syncer disconnected but has other active connections, maintaining syncer status`)
				}
			}

			const presentationSession = await this.presentationState.getPresentationSession(roomID)
			if (presentationSession) {
				const isPublicSharingUser = userId.startsWith('shared_')
				let shouldEndPresentation = false

				if (presentationSession.presenterId === userId) {
					shouldEndPresentation = true
				} else if (isPublicSharingUser) {
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
						continue
					}

					console.log(`[${roomID}] Presenter ${userName} disconnected, ending presentation`)
					await this.presentationState.clearPresentationSession(roomID)

					socket.to(roomID).emit('user-stopped-presenting', {
						userId,
						username: userName,
					})
				}
			}

			const roomUsers = await this.getUserSocketsAndIds(roomID)
			socket.to(roomID).emit('room-user-change', roomUsers)
		}
	}

	async findNewSyncer(roomID) {
		const userSockets = await this.getUserSocketsInRoom(roomID)

		console.log(`[${roomID}] Finding new syncer. Users in room: ${userSockets.length}`)

		if (userSockets.length === 0) {
			console.log(`[${roomID}] No users left in room, no syncer needed`)
			await this.cluster.clearRoomSyncer(roomID)
			if (this.timerService) {
				await this.timerService.clearRoom(roomID)
			}
			if (this.votingService) {
				await this.votingService.clearRoom(roomID)
			}
			return
		}

		await this.cluster.clearRoomSyncer(roomID)

		const userMap = new Map()
		userSockets.forEach((s) => {
			if (!userMap.has(s.userId)) {
				userMap.set(s.userId, [])
			}
			userMap.get(s.userId).push(s)
		})

		for (const [userId, sockets] of userMap.entries()) {
			for (const socketInfo of sockets) {
				const isReadOnly = await this.sessionStore.isReadOnly(socketInfo.socketId)

				if (!isReadOnly) {
					const elected = await this.cluster.trySetRoomSyncer(roomID, userId)

					if (elected) {
						for (const s of sockets) {
							const socketData = await this.sessionStore.getSocketData(s.socketId)
							if (socketData) {
								await this.sessionStore.setSocketData(s.socketId, {
									...socketData,
									isSyncer: true,
									syncerFor: roomID,
								})

								this.io.to(s.socketId).emit('sync-designate', { isSyncer: true })
							}
						}

						console.log(`[${roomID}] Promoted new syncer: ${sockets[0].userName}`)
						return
					}
				}
			}
		}

		console.log(`[${roomID}] No eligible users found for syncer role`)
		await this.cluster.clearRoomSyncer(roomID)
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
				}
			}),
		).then((results) => results.filter(Boolean))
	}

}
