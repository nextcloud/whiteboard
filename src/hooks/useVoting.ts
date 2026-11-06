/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
import { useEffect, useCallback } from 'react'
import { getCurrentUser } from '@nextcloud/auth'
import { showError } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
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

	const { excalidrawAPI } = useExcalidrawStore(useShallow(state => ({
		excalidrawAPI: state.excalidrawAPI,
	})))

	const isConnected = status === 'online' && socket?.connected === true

	// The voting dialog keeps the callback it was opened with, so the connection is read when an action runs
	const connectedRoom = useCallback(() => {
		const { socket, status } = useCollaborationStore.getState()
		const { fileId } = useWhiteboardConfigStore.getState()
		if (!socket || status !== 'online' || !socket.connected || !fileId) {
			console.error('[Voting] Action blocked: Socket not connected or no file ID')
			showError(t('whiteboard', 'Voting requires connection to collaboration server'))
			return null
		}
		return { socket: socket as CollaborationSocket, roomId: String(fileId) }
	}, [])

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
		const room = connectedRoom()
		room?.socket.emit(SOCKET_MSG.VOTING_START, room.roomId, { question, type, options })
		return room !== null
	}, [connectedRoom])

	const vote = useCallback((votingId: string, optionId: string) => {
		const room = connectedRoom()
		room?.socket.emit(SOCKET_MSG.VOTING_VOTE, room.roomId, votingId, optionId)
	}, [connectedRoom])

	const endVoting = useCallback((votingId: string) => {
		const room = connectedRoom()
		room?.socket.emit(SOCKET_MSG.VOTING_END, room.roomId, votingId)
	}, [connectedRoom])

	return {
		startVoting,
		vote,
		endVoting,
		isConnected,
	}
}
