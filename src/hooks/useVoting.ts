/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
import { useEffect, useCallback } from 'react'
import { getCurrentUser } from '@nextcloud/auth'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import type { CollaborationSocket } from '../types/collaboration'
import type { Voting } from '../types/voting'
import { SOCKET_MSG } from '../shared/constants.js'

/**
 * Hook to manage voting functionality via WebSocket collaboration
 * Handles socket event listeners for voting operations
 */
export function useVoting() {
	const { socket, status, addVoting, updateVoting, setVotings } = useCollaborationStore(useShallow(state => ({
		socket: state.socket as CollaborationSocket | null,
		status: state.status,
		addVoting: state.addVoting,
		updateVoting: state.updateVoting,
		setVotings: state.setVotings,
	})))

	const currentUserId = getCurrentUser()?.uid

	const { fileId } = useWhiteboardConfigStore(useShallow(state => ({
		fileId: state.fileId,
	})))

	const { excalidrawAPI } = useExcalidrawStore(useShallow(state => ({
		excalidrawAPI: state.excalidrawAPI,
	})))

	const isConnected = status === 'online' && socket?.connected === true

	const validateConnection = useCallback(() => {
		if (!socket || !isConnected || !fileId) {
			console.error('[Voting] Action blocked: Socket not connected or no file ID')
			return null
		}
		return String(fileId)
	}, [socket, isConnected, fileId])

	useEffect(() => {
		if (!socket || !isConnected) return

		// Consolidated update handler for vote and end events
		const handleVotingUpdate = (voting: Voting) => updateVoting(voting)

		const handleVotingStarted = (voting: Voting) => {
			addVoting(voting)
			// Only auto-open sidebar for the voting creator
			if (voting.author === currentUserId) {
				excalidrawAPI?.toggleSidebar({ name: 'custom', tab: 'voting', force: true })
			}
		}

		socket.on(SOCKET_MSG.VOTINGS_INIT, setVotings)
		socket.on(SOCKET_MSG.VOTING_STARTED, handleVotingStarted)
		socket.on(SOCKET_MSG.VOTING_VOTED, handleVotingUpdate)
		socket.on(SOCKET_MSG.VOTING_ENDED, handleVotingUpdate)

		return () => {
			socket.off(SOCKET_MSG.VOTINGS_INIT, setVotings)
			socket.off(SOCKET_MSG.VOTING_STARTED, handleVotingStarted)
			socket.off(SOCKET_MSG.VOTING_VOTED, handleVotingUpdate)
			socket.off(SOCKET_MSG.VOTING_ENDED, handleVotingUpdate)
		}
	}, [socket, isConnected, addVoting, updateVoting, setVotings, excalidrawAPI, currentUserId])

	const startVoting = useCallback((question: string, type: string, options: string[]) => {
		const roomId = validateConnection()
		if (roomId) {
			socket!.emit(SOCKET_MSG.VOTING_START, roomId, { question, type, options })
		}
	}, [socket, validateConnection])

	const vote = useCallback((votingId: string, optionId: string) => {
		const roomId = validateConnection()
		if (roomId) {
			socket!.emit(SOCKET_MSG.VOTING_VOTE, roomId, votingId, optionId)
		}
	}, [socket, validateConnection])

	const endVoting = useCallback((votingId: string) => {
		const roomId = validateConnection()
		if (roomId) {
			socket!.emit(SOCKET_MSG.VOTING_END, roomId, votingId)
		}
	}, [socket, validateConnection])

	return {
		startVoting,
		vote,
		endVoting,
		isConnected,
	}
}
