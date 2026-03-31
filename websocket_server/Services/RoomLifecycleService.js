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

	async setSocketSyncerState(socketId, roomID, isSyncer) {
		const socketData = await this.sessionStore.getSocketData(socketId)
		if (!socketData) {
			return
		}

		const nextSocketData = {
			...socketData,
			isSyncer,
		}

		if (isSyncer) {
			nextSocketData.syncerFor = roomID
		} else {
			delete nextSocketData.syncerFor
		}

		await this.sessionStore.setSocketData(socketId, nextSocketData)
		this.io.to(socketId).emit('sync-designate', { isSyncer })
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

		let currentSyncer = await this.cluster.getRoomSyncer(validatedRoomId)
		if (currentSyncer?.nodeId && !(await this.cluster.isNodeAlive(currentSyncer.nodeId))) {
			await this.cluster.clearRoomSyncer(validatedRoomId)
			currentSyncer = null
		}

		if (currentSyncer?.socketId) {
			const roomSockets = await this.getUserSocketsInRoom(validatedRoomId)
			const syncerStillPresent = roomSockets.some(({ socketId }) => socketId === currentSyncer.socketId)
			if (!syncerStillPresent) {
				console.log(`[${validatedRoomId}] Clearing stale syncer socket ${currentSyncer.socketId}`)
				await this.cluster.clearRoomSyncer(validatedRoomId)
				currentSyncer = null
			}
		}
		const isReadOnly = await this.sessionStore.isReadOnly(socket.id)

		let isSyncer = false

		if (!currentSyncer?.socketId && currentSyncer?.userId === userId && !isReadOnly) {
			await this.cluster.setRoomSyncer(validatedRoomId, {
				userId,
				socketId: socket.id,
				nodeId: socketData.nodeId,
			})
			await this.setSocketSyncerState(socket.id, validatedRoomId, true)
			isSyncer = true
			console.log(`[${validatedRoomId}] Recovered legacy syncer state for ${userName}`)
		} else if (!currentSyncer && !isReadOnly) {
			const elected = await this.cluster.trySetRoomSyncer(validatedRoomId, {
				userId,
				socketId: socket.id,
				nodeId: socketData.nodeId,
			})

			if (elected) {
				await this.setSocketSyncerState(socket.id, validatedRoomId, true)
				isSyncer = true
				console.log(`[${validatedRoomId}] Designated new syncer: ${userName} (${socket.id})`)
			} else {
				await this.setSocketSyncerState(socket.id, validatedRoomId, false)
				isSyncer = false
				console.log(`[${validatedRoomId}] User ${userName} lost syncer election (another user won)`)
			}
		} else {
			await this.setSocketSyncerState(socket.id, validatedRoomId, false)
			isSyncer = false
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
			const wasSyncer = currentSyncer?.socketId
				? currentSyncer.socketId === socket.id
				: currentSyncer?.userId === userId

			if (wasSyncer) {
				console.log(`[${roomID}] Syncer socket disconnecting, finding replacement`)
				await this.findNewSyncer(roomID, { preferredUserId: userId, excludeSocketId: socket.id })
			}

			const presentationSession = await this.presentationState.getPresentationSession(roomID)
			if (presentationSession) {
				const isPublicSharingUser = typeof userId === 'string' && userId.startsWith('shared_')
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

	async findNewSyncer(roomID, { preferredUserId = null, excludeSocketId = null } = {}) {
		const userSockets = (await this.getUserSocketsInRoom(roomID))
			.filter(({ socketId }) => socketId !== excludeSocketId)

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

		const prioritizedSockets = preferredUserId
			? [
				...userSockets.filter((socketInfo) => socketInfo.userId === preferredUserId),
				...userSockets.filter((socketInfo) => socketInfo.userId !== preferredUserId),
			]
			: userSockets

		for (const socketInfo of prioritizedSockets) {
			const isReadOnly = await this.sessionStore.isReadOnly(socketInfo.socketId)

			if (!isReadOnly) {
				const elected = await this.cluster.trySetRoomSyncer(roomID, {
					userId: socketInfo.userId,
					socketId: socketInfo.socketId,
					nodeId: socketInfo.nodeId,
				})

				if (elected) {
					await this.setSocketSyncerState(socketInfo.socketId, roomID, true)
					console.log(`[${roomID}] Promoted new syncer: ${socketInfo.userName} (${socketInfo.socketId})`)
					return
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
					clientType: data.clientType,
					nodeId: data.nodeId || null,
				}
			}),
		).then((results) => results.filter(Boolean))
	}

}
