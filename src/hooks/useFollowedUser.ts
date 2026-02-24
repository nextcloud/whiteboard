/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import type { OnUserFollowedPayload } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import logger from '../utils/logger'

type UseFollowedUserOptions = {
	excalidrawAPI: ExcalidrawImperativeAPI | null
	fileId: number
}

export function useFollowedUser({ excalidrawAPI, fileId }: UseFollowedUserOptions) {
	const handleUserFollow = useCallback((payload: OnUserFollowedPayload) => {
		const targetUserId = payload.userToFollow?.socketId
		if (!targetUserId) {
			logger.warn('[Collaboration] Invalid follow payload', payload)
			return
		}

		if (payload.action === 'FOLLOW') {
			useCollaborationStore.setState({ followedUserId: targetUserId })
			const { socket } = useCollaborationStore.getState()
			if (socket?.connected && Number.isFinite(fileId)) {
				socket.emit('request-viewport', {
					fileId: fileId.toString(),
					userId: targetUserId,
				})
			}
			logger.info(`[Collaboration] Following user from UI: ${targetUserId}`)
			return
		}

		const currentFollowed = useCollaborationStore.getState().followedUserId
		if (currentFollowed === targetUserId) {
			useCollaborationStore.setState({ followedUserId: null })
			logger.info(`[Collaboration] Stopped following user from UI: ${targetUserId}`)
		}
	}, [fileId])

	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}

		const unsubscribe = excalidrawAPI.onUserFollow(handleUserFollow)
		return () => {
			if (typeof unsubscribe === 'function') {
				unsubscribe()
			}
		}
	}, [excalidrawAPI, handleUserFollow])

	// Expose followUser globally for recording agent access
	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}

		window.followUser = (userId: string) => {
			if (!excalidrawAPI) {
				logger.warn('[Collaboration] Cannot follow user: Excalidraw API not available')
				return
			}

			const currentSocket = useCollaborationStore.getState().socket
			if (!currentSocket?.connected) {
				logger.warn('[Collaboration] Cannot follow user: Socket not connected')
				return
			}

			useCollaborationStore.setState({ followedUserId: userId })
			logger.info(`[Collaboration] Recording agent now following user: ${userId}`)

			if (Number.isFinite(fileId)) {
				currentSocket.emit('request-viewport', {
					fileId: fileId.toString(),
					userId,
				})
				logger.info(`[Collaboration] Recording agent requested viewport for user: ${userId}`)
			} else {
				logger.warn('[Collaboration] Cannot request viewport: Invalid fileId', { fileId })
			}

			const state = useCollaborationStore.getState()
			logger.debug('[Collaboration] Current collaboration store state:', {
				followedUserId: state.followedUserId,
				socketConnected: state.socket?.connected,
				status: state.status,
			})
		}

		const unsubscribe = useCollaborationStore.subscribe((state) => {
			if (state.socket?.connected) {
				window.collaborationReady = true
				unsubscribe()
			}
		})

		return () => {
			delete window.followUser
			delete window.collaborationReady
		}
	}, [excalidrawAPI, fileId])
}
