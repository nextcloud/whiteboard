import { v4 as uuidv4 } from 'uuid'

class VotingManager {

	constructor(roomDataManager) {
		this.roomDataManager = roomDataManager
	}

	async createVoting(roomId, question, author, type, options) {
		const votingId = uuidv4()
		const voting = {
			uuid: votingId,
			state: 'open',
			question,
			author,
			type,
			options: options.map(option => ({
				uuid: uuidv4(),
				type: 'answer',
				title: option,
				votes: [],
			})),
		}
		return await this.persistVotingToRoom(roomId, votingId, voting)
	}

	async addVote(roomId, votingId, optionId, userId) {
		const room = await this.roomDataManager.getOrCreateRoom(roomId)
		const voting = room.getVoting(votingId)
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
		option.votes.push(userId)
		return await this.persistVotingToRoom(roomId, votingId, voting)
	}

	async endVoting(roomId, votingId, userId) {
		const room = await this.roomDataManager.getOrCreateRoom(roomId)
		const voting = room.getVoting(votingId)
		if (!voting) {
			throw new Error('Voting not found')
		}
		if (voting.author !== userId) {
			throw new Error('Only the author can end the voting')
		}
		voting.state = 'closed'
		return await this.persistVotingToRoom(roomId, votingId, voting)
	}

	async persistVotingToRoom(roomId, votingId, voting) {
		const room = await this.roomDataManager.getOrCreateRoom(roomId)
		room.addVoting(votingId, voting)
		await this.roomDataManager.storageManager.set(roomId, room)
		return voting
	}

	async getAllVotings(roomId) {
		const room = await this.roomDataManager.getOrCreateRoom(roomId)
		return room.getVotings()
	}

}

export default VotingManager
