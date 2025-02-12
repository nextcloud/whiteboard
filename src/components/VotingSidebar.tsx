import type { Voting, VotingOption } from '../types'
import './VotingSidebar.css'
import { Collab } from '../collaboration/collab'
import { getCurrentUser } from '@nextcloud/auth'
import { spawnDialog } from '@nextcloud/dialogs'
import VotingModal from '../VotingModal.vue'

interface VotingSidebarProps {
	votings: Array<Voting>
    collab: Collab;
}

export function VotingSidebar({ votings, collab }: VotingSidebarProps) {
	const handleVote = (voting: Voting, option: VotingOption) => {
		// Only allow voting if the voting is still open
		if (voting.state === 'open') {
			collab.vote(voting, option)
		}
	}

	const hasVoted = (option: VotingOption): boolean => {
		return option.votes.includes(getCurrentUser()?.uid)
	}

	const canVote = (voting: Voting): boolean => {
		return voting.state === 'open' && !voting.options.some(opt => hasVoted(opt))
	}

	const handleEndVoting = (voting: Voting) => {
		if (voting.state === 'open') {
			collab.endVoting(voting)
		}
	}

	const isAuthor = (voting: Voting): boolean => {
		const currentUserId = getCurrentUser()?.uid
		return voting.author === currentUserId
	}

	const calculatePercentage = (option: VotingOption, voting: Voting): number => {
		const totalVotes = voting.options.reduce((sum, opt) => sum + opt.votes.length, 0)
		return totalVotes === 0 ? 0 : (option.votes.length / totalVotes) * 100
	}

	const addResultAsElements = (voting: Voting) => {
		const width = 400
		const barHeight = 40
		const padding = 20
		const maxBarWidth = width - 150
		const totalVotes = voting.options.reduce((sum, opt) => sum + opt.votes.length, 0)

		// Get current viewport center
		const appState = collab.excalidrawAPI.getAppState()
		const centerX = appState.scrollX + appState.width / 2
		const centerY = appState.scrollY + appState.height / 2

		const elements = []

		// Create frame
		const frameHeight = (voting.options.length * (barHeight + padding)) + 80 // Extra space for title
		const frameWidth = width + 40 // Extra padding
		const frameX = centerX - frameWidth / 2
		const frameY = centerY - frameHeight / 2
		const frameId = `voting-frame-${Date.now()}`

		console.debug('Generating excalidraw elements for voting', { ...voting })

		elements.push({
			type: 'frame',
			x: frameX,
			y: frameY,
			width: frameWidth,
			height: frameHeight,
			id: frameId,
			name: 'Voting Results',
			backgroundColor: 'transparent',
			version: 1,
			versionNonce: 1,
			isDeleted: false,
			opacity: 100,
			angle: 0,
			groupIds: [],
		})

		// Add title
		elements.push({
			type: 'text',
			text: voting.question,
			x: centerX - width / 2,
			y: centerY - (voting.options.length * (barHeight + padding) / 2) - 40,
			width,
			height: 30,
			fontSize: 20,
			fontFamily: 3,
			textAlign: 'left',
			verticalAlign: 'middle',
			id: `voting-title-${Date.now()}`,
			version: 1,
			versionNonce: 1,
			isDeleted: false,
			fillStyle: 'solid',
			strokeWidth: 1,
			strokeStyle: 'solid',
			roughness: 0,
			opacity: 100,
			angle: 0,
			groupIds: [],
			strokeColor: '#1e1e1e',
			backgroundColor: 'transparent',
			frameId,
		})

		// Add bars and labels
		voting.options.forEach((option, index) => {
			const percentage = totalVotes === 0 ? 0 : (option.votes.length / totalVotes) * 100
			const barWidth = (percentage / 100) * maxBarWidth
			const y = centerY - (voting.options.length * (barHeight + padding) / 2) + index * (barHeight + padding)

			// Add label
			elements.push({
				type: 'text',
				text: option.title,
				x: centerX - width / 2,
				y: y + barHeight / 2 - 10,
				width: 140,
				height: 20,
				fontSize: 16,
				fontFamily: 3,
				textAlign: 'left',
				verticalAlign: 'middle',
				id: `voting-${frameId}-label-${option.uuid}`,
				version: 1,
				versionNonce: 1,
				isDeleted: false,
				fillStyle: 'solid',
				strokeWidth: 1,
				strokeStyle: 'solid',
				roughness: 0,
				opacity: 100,
				angle: 0,
				groupIds: [],
				strokeColor: '#1e1e1e',
				backgroundColor: 'transparent',
				frameId,
			})

			// Add bar
			elements.push({
				type: 'rectangle',
				x: centerX - width / 2 + 150,
				y,
				width: Math.max(barWidth, 10), // minimum width for visibility
				height: barHeight,
				id: `voting-${frameId}-bar-${option.uuid}`,
				version: 1,
				versionNonce: 1,
				isDeleted: false,
				fillStyle: 'solid',
				strokeWidth: 2,
				strokeStyle: 'solid',
				roughness: 0,
				opacity: 100,
				angle: 0,
				groupIds: [],
				strokeColor: '#1e1e1e',
				backgroundColor: '#228be6',
				frameId,
			})

			// Add vote count
			elements.push({
				type: 'text',
				text: `${option.votes.length} (${percentage.toFixed(1)}%)`,
				x: centerX - width / 2 + 170 + barWidth, // Added 10px more spacing
				y: y + barHeight / 2 - 10,
				width: 100,
				height: 20,
				fontSize: 16,
				fontFamily: 3,
				textAlign: 'left',
				verticalAlign: 'middle',
				id: `voting-${frameId}-count-${option.uuid}`,
				version: 1,
				versionNonce: 1,
				isDeleted: false,
				fillStyle: 'solid',
				strokeWidth: 1,
				strokeStyle: 'solid',
				roughness: 0,
				opacity: 100,
				angle: 0,
				groupIds: [],
				strokeColor: '#1e1e1e',
				backgroundColor: 'transparent',
				frameId,
			})
		})

		// Add all elements to the scene
		collab.excalidrawAPI.updateScene({
			elements: [
				...collab.excalidrawAPI.getSceneElements(),
				...elements,
			],
		})
	}

	const handleStartVoting = () => {
		spawnDialog(VotingModal, {
			title: 'Start Voting',
			collab,
		})
	}

	const isReadOnly = collab.isReadOnly()

	return (
		<div className="voting-list">
			<div className="voting-header-main">
				{!isReadOnly && (
					<button
						onClick={handleStartVoting}
						className="start-voting-button">
						Start new voting
					</button>
				)}
			</div>
			{votings.map((voting) => (
				<div key={voting.uuid} className="voting-item">
					<div className="voting-header">
						<h3>{voting.question}</h3>
						<div className="voting-actions">
							{isAuthor(voting) && voting.state === 'open' && (
								<button
									onClick={() => handleEndVoting(voting)}
									className="end-voting-button">
									End voting
								</button>
							)}
							{voting.state === 'closed' && (
								<button
									onClick={() => addResultAsElements(voting)}
									className="add-result-button">
                                    Add as drawing
								</button>
							)}
						</div>
					</div>
					<div className="voting-status">
						Status: {voting.state}
					</div>
					<ul className="voting-answers">
						{voting.options.map((option) => (
							<li key={option.uuid} className="voting-option">
								<div className="option-content">
									<div className="option-header">
										<span className="option-title">{option.title}</span>
										{canVote(voting) && (
											<button
												onClick={() => handleVote(voting, option)}
												className="vote-button">
												Vote
											</button>
										)}
										{hasVoted(option) && (
											<span className="voted-indicator">✓ Voted</span>
										)}
									</div>
									<div className="option-stats">
										<div className="vote-bar-container">
											<div
												className="vote-bar"
												style={{ width: `${calculatePercentage(option, voting)}%` }}
											/>
										</div>
										<span className="vote-count">({option.votes.length} votes)</span>
									</div>
								</div>
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	)
}
