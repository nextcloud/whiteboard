/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { v4 as uuidv4 } from 'uuid'

class VotingManager {

	#votings = {}

	constructor() {
		this.#votings = {}
	}

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
		return this.persistVotingToRoom(roomId, votingId, voting)
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
		return this.persistVotingToRoom(roomId, votingId, voting)
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
		return this.persistVotingToRoom(roomId, votingId, voting)
	}

	getVoting(roomId, votingId) {
		if (!this.#votings[roomId]) {
			return null
		}
		return this.#votings[roomId].get(votingId) || null
	}

	persistVotingToRoom(roomId, votingId, voting) {
		if (!this.#votings[roomId]) {
			this.#votings[roomId] = new Map()
		}
		this.#votings[roomId].set(votingId, voting)
		return voting
	}

	getAllVotings(roomId) {
		if (!this.#votings[roomId]) {
			this.#votings[roomId] = new Map()
		}
		return Array.from(this.#votings[roomId].values())
	}

	setRoomVotings(roomId, votings = []) {
		this.#votings[roomId] = new Map()
		for (const voting of votings) {
			if (voting?.uuid) {
				this.#votings[roomId].set(voting.uuid, voting)
			}
		}
	}

	exportRoomVotings(roomId) {
		return this.getAllVotings(roomId)
	}

	cleanupRoom(roomId) {
		if (this.#votings[roomId]) {
			delete this.#votings[roomId]
		}
	}

}

export default VotingManager
