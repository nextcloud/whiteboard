/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { v4 as uuidv4 } from 'uuid'
import Config from '../Utilities/ConfigUtility.js'
import GeneralUtility from '../Utilities/GeneralUtility.js'
import { SOCKET_MSG } from '../../src/shared/constants.js'

export default class VotingService {

	static CLEANUP_INTERVAL_MS = 60000
	static STALE_THRESHOLD_MS = 3600000

	constructor({ io, sessionStore, roomStateStore }) {
		this.io = io
		this.sessionStore = sessionStore
		this.roomStateStore = roomStateStore
		this.votings = new Map()
		this.cleanupInterval = null
		this.startCleanupInterval()
	}

	startCleanupInterval() {
		if (this.cleanupInterval) return
		this.cleanupInterval = setInterval(() => {
			this.cleanupStaleVotings()
		}, VotingService.CLEANUP_INTERVAL_MS)
	}

	stopCleanupInterval() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval)
			this.cleanupInterval = null
		}
	}

	cleanupStaleVotings() {
		const now = Date.now()
		for (const [roomId, roomVotings] of this.votings.entries()) {
			const allClosed = Array.from(roomVotings.values()).every(v => v.state === 'closed')
			if (allClosed && roomVotings.size > 0) {
				const oldestVoting = Array.from(roomVotings.values())
					.reduce((oldest, v) => (!oldest || v.startedAt < oldest.startedAt ? v : oldest), null)
				if (oldestVoting && now - oldestVoting.startedAt > VotingService.STALE_THRESHOLD_MS) {
					this.votings.delete(roomId)
					console.log(`[${roomId}] Cleaned up stale votings`)
				}
			}
		}
	}

	#getVotingKey(roomId) {
		return `room:${roomId}:votings`
	}

	#getRoomMap(roomId) {
		if (!this.votings.has(roomId)) {
			this.votings.set(roomId, new Map())
		}
		return this.votings.get(roomId)
	}

	getAllVotings(roomId) {
		return Array.from(this.#getRoomMap(roomId).values())
	}

	setRoomVotings(roomId, votings = []) {
		const map = new Map()
		for (const voting of votings) {
			if (voting?.uuid) {
				map.set(voting.uuid, voting)
			}
		}
		this.votings.set(roomId, map)
	}

	async hydrateForSocket(roomID, socket) {
		await this.loadVotings(roomID)
		const existingVotings = this.getAllVotings(roomID)
		if (existingVotings.length > 0) {
			console.log(`[${roomID}] Sending ${existingVotings.length} existing voting(s) to socket ${socket.id}`)
			socket.emit(SOCKET_MSG.VOTINGS_INIT, existingVotings)
		}
	}

	async loadVotings(roomID) {
		const stored = await this.roomStateStore.getValue(this.#getVotingKey(roomID))
		if (stored && Array.isArray(stored)) {
			this.setRoomVotings(roomID, stored)
		}
	}

	async persistVotings(roomID) {
		const votings = this.getAllVotings(roomID)
		if (votings.length === 0) {
			await this.roomStateStore.deleteValue(this.#getVotingKey(roomID))
			return
		}
		await this.roomStateStore.setValue(this.#getVotingKey(roomID), votings, {
			ttlMs: Config.SESSION_TTL,
		})
	}

	async clearRoom(roomID) {
		this.votings.delete(roomID)
		await this.roomStateStore.deleteValue(this.#getVotingKey(roomID))
	}

	// Voting operations
	async start(socket, roomID, votingData) {
		try {
			const isReadOnly = await this.sessionStore.isReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			await this.loadVotings(roomID)

			const { question, type, options } = votingData
			const socketData = await this.sessionStore.getSocketData(socket.id)
			const voting = this.createVoting(roomID, question, socketData.user.id, type, options)

			GeneralUtility.logOperation(roomID, `Started voting: ${JSON.stringify(votingData)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_STARTED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error starting voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-start' })
		}
	}

	async vote(socket, roomID, votingId, optionId) {
		try {
			const isReadOnly = await this.sessionStore.isReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			await this.loadVotings(roomID)

			const socketData = await this.sessionStore.getSocketData(socket.id)
			const voting = this.addVote(roomID, votingId, optionId, socketData.user.id)

			GeneralUtility.logOperation(roomID, `${socketData.user.id} voted: ${JSON.stringify(voting)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_VOTED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-vote' })
		}
	}

	async end(socket, roomID, votingId) {
		try {
			const isReadOnly = await this.sessionStore.isReadOnly(socket.id)
			if (!socket.rooms.has(roomID) || isReadOnly) return

			await this.loadVotings(roomID)

			const socketData = await this.sessionStore.getSocketData(socket.id)

			const voting = this.endVoting(roomID, votingId, socketData.user.id)

			GeneralUtility.logOperation(roomID, `Voting closed: ${JSON.stringify(voting)}`)

			this.io.to(roomID).emit(SOCKET_MSG.VOTING_ENDED, voting)
			await this.persistVotings(roomID)
		} catch (error) {
			console.error(`[${roomID}] Error ending voting:`, error.message)
			socket.emit('error', { message: error.message, context: 'voting-end' })
		}
	}

	// Internal voting logic
	createVoting(roomId, question, author, type, options) {
		if (!author || typeof author !== 'string' || author.trim() === '') {
			throw new Error('Invalid author ID')
		}
		const existingVotings = this.getAllVotings(roomId)
		if (existingVotings.length >= 50) {
			throw new Error('Maximum 50 votings per room reached')
		}
		if (!question || question.trim() === '') {
			throw new Error('Question cannot be empty')
		}
		if (!type || type.trim() === '') {
			throw new Error('Type cannot be empty')
		}
		const validTypes = ['single-choice', 'multiple-choice']
		if (!validTypes.includes(type)) {
			throw new Error(`Invalid voting type. Must be one of: ${validTypes.join(', ')}`)
		}
		if (!Array.isArray(options) || options.length < 2) {
			throw new Error('At least 2 options are required')
		}
		const validOptions = options.filter(opt => opt && opt.trim() !== '')
		if (validOptions.length < 2) {
			throw new Error('At least 2 non-empty options are required')
		}
		if (validOptions.length > 20) {
			throw new Error('Maximum 20 options allowed per voting')
		}

		const votingId = uuidv4()
		const voting = {
			uuid: votingId,
			state: 'open',
			question: question.trim(),
			author,
			type,
			options: validOptions.map(option => ({
				uuid: uuidv4(),
				type: 'answer',
				title: option.trim(),
				votes: [],
			})),
			startedAt: Date.now(),
		}
		this.persistVotingToRoom(roomId, votingId, voting)
		return voting
	}

	addVote(roomId, votingId, optionId, userId) {
		if (!userId || typeof userId !== 'string' || userId.trim() === '') {
			throw new Error('Invalid user ID')
		}
		const voting = this.getVoting(roomId, votingId)
		if (!voting || voting.state !== 'open') {
			throw new Error('Voting not found or not open')
		}
		const option = voting.options.find(opt => opt.uuid === optionId)
		if (!option) {
			throw new Error('Option not found')
		}
		if (!option.votes) {
			option.votes = []
		}
		if (option.votes.includes(userId)) {
			throw new Error('User has already voted for this option')
		}
		if (voting.type === 'single-choice') {
			const hasVoted = voting.options.some(opt => opt.votes.includes(userId))
			if (hasVoted) {
				throw new Error('User has already voted in this single-choice voting')
			}
		}
		option.votes.push(userId)
		this.persistVotingToRoom(roomId, votingId, voting)
		return voting
	}

	endVoting(roomId, votingId, userId) {
		if (!userId || typeof userId !== 'string' || userId.trim() === '') {
			throw new Error('Invalid user ID')
		}
		const voting = this.getVoting(roomId, votingId)
		if (!voting) {
			throw new Error('Voting not found')
		}
		if (voting.author !== userId) {
			throw new Error('Only the author can end the voting')
		}
		voting.state = 'closed'
		this.persistVotingToRoom(roomId, votingId, voting)
		return voting
	}

	getVoting(roomId, votingId) {
		return this.#getRoomMap(roomId).get(votingId) || null
	}

	persistVotingToRoom(roomId, votingId, voting) {
		this.#getRoomMap(roomId).set(votingId, voting)
		return voting
	}

}
