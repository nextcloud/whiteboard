/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Voting, VotingOption } from '../types'
import './VotingSidebar.css'
import { getCurrentUser } from '@nextcloud/auth'
import { spawnDialog, showError } from '@nextcloud/dialogs'
import { translate as t, translatePlural as n } from '@nextcloud/l10n'
import VotingModal from './VotingModal.vue'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { v4 as uuidv4 } from 'uuid'
import { convertToExcalidrawElements } from '@nextcloud/excalidraw'

interface VotingSidebarProps {
	votings: Array<Voting>
	onVote: (votingId: string, optionId: string) => void
	onEndVoting: (votingId: string) => void
	onStartVoting: (question: string, type: string, options: string[]) => void
	excalidrawAPI: ExcalidrawImperativeAPI | null
	isReadOnly: boolean
}

export function VotingSidebar({ votings, onVote, onEndVoting, onStartVoting, excalidrawAPI, isReadOnly }: VotingSidebarProps) {
	const currentUserId = getCurrentUser()?.uid

	const hasVoted = (option: VotingOption) => currentUserId ? option.votes.includes(currentUserId) : false
	const isAuthor = (voting: Voting) => currentUserId ? voting.author === currentUserId : false
	const isOpen = (voting: Voting) => voting.state === 'open'
	const hasVotedInVoting = (voting: Voting) => voting.options.some(hasVoted)
	const canVote = (voting: Voting) => {
		if (!currentUserId || !isOpen(voting)) return false
		// For single-choice, can't vote if already voted
		if (voting.type === 'single-choice' && hasVotedInVoting(voting)) return false
		// For multiple-choice, can always vote (on options not yet voted for)
		return true
	}

	const getTotalVotes = (voting: Voting) => voting.options.reduce((sum: number, opt: VotingOption) => sum + opt.votes.length, 0)
	const calculatePercentage = (option: VotingOption, voting: Voting) => {
		const total = getTotalVotes(voting)
		return total === 0 ? 0 : (option.votes.length / total) * 100
	}

	const handleVote = (voting: Voting, option: VotingOption) => {
		if (isOpen(voting)) onVote(voting.uuid, option.uuid)
	}

	const handleEndVoting = (voting: Voting) => {
		if (isOpen(voting)) onEndVoting(voting.uuid)
	}

	const splitIntoLines = (text: string, maxCharsPerLine: number) => {
		let questionText = ''
		let currentLine = ''
		for (const word of text.split(' ')) {
			if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
				currentLine = (currentLine + ' ' + word).trim()
			} else {
				questionText += currentLine + '\n'
				currentLine = word
			}
		}
		questionText += currentLine

		return questionText
	}

	const addResultAsElements = (voting: Voting) => {
		if (!excalidrawAPI) {
			showError(t('whiteboard', 'Canvas not ready. Please try again.'))
			return
		}

		try {
			// Layout constants
			const LAYOUT = {
				width: 600,
				barHeight: 40,
				optionPadding: 30,
				statsWidth: 120,
				optionLeftMargin: 260,
				questionBottomPadding: 40,
				framePadding: { horizontal: 40, vertical: 60, top: 30 },
			}

			const TYPOGRAPHY = {
				question: {
					fontSize: 20,
					lineHeight: 1.25,
					get charsPerLine() {
						// Average character width is approximately 0.6 * fontSize for most fonts
						return Math.floor(LAYOUT.width / (this.fontSize * 0.6))
					},
				},
				option: {
					fontSize: 16,
					lineHeight: 1.25,
					titleWidth: 240,
					get titleCharsPerLine() {
						// Average character width is approximately 0.6 * fontSize for most fonts
						return Math.floor(this.titleWidth / (this.fontSize * 0.6))
					},
				},
			}

			const maxBarWidth = LAYOUT.width - LAYOUT.optionLeftMargin - LAYOUT.statsWidth - 20

			const appState = excalidrawAPI.getAppState()
			if (!appState) {
				throw new Error(t('whiteboard', 'Could not get app state'))
			}

			const centerX = appState.scrollX + appState.width / 2
			const centerY = appState.scrollY + appState.height / 2
			const frameId = `voting-frame-${uuidv4()}`

			// Calculate question dimensions
			const questionText = splitIntoLines(voting.question, TYPOGRAPHY.question.charsPerLine)
			const questionLines = questionText.split('\n').length
			const questionHeight = questionLines * TYPOGRAPHY.question.fontSize * TYPOGRAPHY.question.lineHeight + 10

			// Calculate option heights
			const optionHeights = voting.options.map((option: VotingOption) => {
				const optionText = splitIntoLines(option.title, TYPOGRAPHY.option.titleCharsPerLine)
				const optionLines = optionText.split('\n').length
				const textHeight = optionLines * TYPOGRAPHY.option.fontSize * TYPOGRAPHY.option.lineHeight + 10
				return Math.max(textHeight, LAYOUT.barHeight)
			})

			// Calculate frame dimensions
			const optionsHeight = optionHeights.reduce((sum, height) => sum + height + LAYOUT.optionPadding, 0)
			const frameHeight = questionHeight + LAYOUT.questionBottomPadding + optionsHeight + LAYOUT.framePadding.vertical
			const frameWidth = LAYOUT.width + LAYOUT.framePadding.horizontal
			const frameX = centerX - frameWidth / 2
			const frameY = centerY - frameHeight / 2

			// Create elements
			const skeletonElements = []
			const questionY = frameY + LAYOUT.framePadding.top

			// Add question element
			skeletonElements.push({
				type: 'text',
				text: questionText,
				x: centerX - LAYOUT.width / 2,
				y: questionY,
				width: LAYOUT.width,
				fontSize: TYPOGRAPHY.question.fontSize,
				fontFamily: 3,
				textAlign: 'left',
				lineHeight: TYPOGRAPHY.question.lineHeight,
				frameId,
			})

			// Add option elements
			let currentY = questionY + questionHeight + LAYOUT.questionBottomPadding

			voting.options.forEach((option: VotingOption, index: number) => {
				const percentage = calculatePercentage(option, voting)
				const barWidth = (percentage / 100) * maxBarWidth
				const optionHeight = optionHeights[index]

				const optionText = splitIntoLines(option.title, TYPOGRAPHY.option.titleCharsPerLine)
				const optionLines = optionText.split('\n').length
				const textHeight = optionLines * TYPOGRAPHY.option.fontSize * TYPOGRAPHY.option.lineHeight

				const textY = currentY
				const textMiddle = textY + textHeight / 2
				const barY = textMiddle - LAYOUT.barHeight / 2
				const statsY = textMiddle - TYPOGRAPHY.option.fontSize / 2

				// Option title
				skeletonElements.push({
					type: 'text',
					text: optionText,
					x: centerX - LAYOUT.width / 2,
					y: textY,
					width: TYPOGRAPHY.option.titleWidth,
					fontSize: TYPOGRAPHY.option.fontSize,
					fontFamily: 3,
					textAlign: 'left',
					lineHeight: TYPOGRAPHY.option.lineHeight,
					frameId,
				})

				// Vote bar
				skeletonElements.push({
					type: 'rectangle',
					x: centerX - LAYOUT.width / 2 + LAYOUT.optionLeftMargin,
					y: barY,
					width: Math.max(barWidth, 10),
					height: LAYOUT.barHeight,
					backgroundColor: '#228be6',
					strokeWidth: 0,
					frameId,
				})

				// Vote statistics
				skeletonElements.push({
					type: 'text',
					text: `${option.votes.length} (${percentage.toFixed(1)}%)`,
					x: centerX - LAYOUT.width / 2 + LAYOUT.optionLeftMargin + maxBarWidth + 10,
					y: statsY,
					width: LAYOUT.statsWidth,
					fontSize: TYPOGRAPHY.option.fontSize,
					fontFamily: 3,
					textAlign: 'left',
					lineHeight: TYPOGRAPHY.option.lineHeight,
					frameId,
				})

				currentY += optionHeight + LAYOUT.optionPadding
			})

			// Assign IDs to elements
			const ids = skeletonElements.map((el) => {
				el.id = `voting-${uuidv4()}`
				return el.id
			})

			// Add frame element
			skeletonElements.push({
				type: 'frame',
				x: frameX,
				y: frameY,
				width: frameWidth,
				height: frameHeight,
				id: frameId,
				children: ids,
				name: t('whiteboard', 'Voting results'),
			})

			// Update scene
			const elements = convertToExcalidrawElements(skeletonElements)
			const existingElements = excalidrawAPI.getSceneElements()

			if (!existingElements) {
				throw new Error(t('whiteboard', 'Could not get scene elements'))
			}

			excalidrawAPI.updateScene({
				elements: [...elements],
			})
		} catch (error) {
			console.error('Error adding voting results to canvas:', error)
			showError(t('whiteboard', 'Failed to add voting results to canvas'))
		}
	}

	const handleStartVoting = () => {
		spawnDialog(VotingModal, {
			onStartVoting,
		}, () => {})
	}

	const sortedVotings = [...votings].sort((a, b) => b.startedAt - a.startedAt)

	return (
		<div className="voting-list">
			<div className="voting-header-main">
				{!isReadOnly && (
					<button
						onClick={handleStartVoting}
						className="start-voting-button">
						{t('whiteboard', 'Start new voting')}
					</button>
				)}
			</div>
			{sortedVotings.map((voting) => (
				<div key={voting.uuid} className="voting-item">
					<h4>{voting.question}</h4>
					<div className="voting-actions">
						{isAuthor(voting) && isOpen(voting) && (
							<button
								onClick={() => handleEndVoting(voting)}
								className="end-voting-button">
								{t('whiteboard', 'End voting')}
							</button>
						)}
						{!isOpen(voting) && (
							<button
								onClick={() => addResultAsElements(voting)}
								className="add-result-button">
								{t('whiteboard', 'Add as drawing')}
							</button>
						)}
					</div>
					<div className="voting-status">
						{t('whiteboard', 'Status')}: {voting.state === 'open' ? t('whiteboard', 'Open') : t('whiteboard', 'Closed')}
					</div>
					<ul className="voting-answers">
						{voting.options.map((option: VotingOption) => (
							<li key={option.uuid} className="voting-option">
								<div className="option-content">
									<div className="option-header">
										<span className="option-title">{option.title}</span>
										{canVote(voting) && (
											<button
												onClick={() => handleVote(voting, option)}
												className="vote-button">
												{t('whiteboard', 'Vote')}
											</button>
										)}
										{hasVoted(option) && (
											<span className="voted-indicator">✓ {t('whiteboard', 'Voted')}</span>
										)}
									</div>
									<div className="option-stats">
										<div className="vote-bar-container">
											<div
												className="vote-bar"
												style={{ width: `${calculatePercentage(option, voting)}%` }}
											/>
										</div>
										<span className="vote-count">
											({n('whiteboard', '%n vote', '%n votes', option.votes.length)})
										</span>
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
