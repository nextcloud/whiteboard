/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useJWTStore } from '../stores/useJwtStore'
import type { PresentationState } from '../types/presentation'
import type { CollaborationSocket } from '../types/collaboration'

interface UsePresentationProps {
	fileId: number
}

export function usePresentation({ fileId }: UsePresentationProps): PresentationState {
	// Local state for UI feedback
	const [status, setStatus] = useState<'idle' | 'starting' | 'presenting' | 'stopping'>('idle')
	const [error, setError] = useState<string | null>(null)
	const [presenterName, setPresenterName] = useState<string | null>(null)

	// Get collaboration state
	const {
		socket,
		status: connectionStatus,
		presenterId,
		isPresentationMode,
		isPresenting,
		presentationStartTime,
		autoFollowPresenter,
		setPresentationState,
		setAutoFollowPresenter,
	} = useCollaborationStore(
		useShallow((state) => ({
			socket: state.socket as CollaborationSocket | null,
			status: state.status,
			presenterId: state.presenterId,
			isPresentationMode: state.isPresentationMode,
			isPresenting: state.isPresenting,
			presentationStartTime: state.presentationStartTime,
			autoFollowPresenter: state.autoFollowPresenter,
			setPresentationState: state.setPresentationState,
			setAutoFollowPresenter: state.setAutoFollowPresenter,
		})),
	)

	const isConnected = connectionStatus === 'online'

	// Get current user info
	const { getJWT, parseJwt } = useJWTStore()

	// Update status based on presentation state
	useEffect(() => {
		if (isPresenting) {
			setStatus('presenting')
		} else if (isPresentationMode && !isPresenting) {
			setStatus('idle')
		} else {
			setStatus('idle')
		}
	}, [isPresenting, isPresentationMode])

	// Start presentation
	const startPresentation = useCallback(async () => {
		if (!socket || !isConnected) {
			setError('Presentation requires connection to collaboration server. Please check your network connection.')
			return
		}

		if (isPresentationMode && presenterId) {
			setError('Another user is already presenting. Please wait for them to finish.')
			return
		}

		try {
			setStatus('starting')
			setError(null)

			// Get current user info
			const jwt = await getJWT()
			if (!jwt) {
				throw new Error('Authentication required for presentation')
			}

			const jwtPayload = parseJwt(jwt)
			if (!jwtPayload?.userid) {
				throw new Error('Invalid authentication token')
			}

			// console.log('[Presentation] Emitting presentation-start event:', {
			//  fileId: fileId.toString(),
			//  userId: jwtPayload.userid,
			// })

			// Emit start presentation event
			socket.emit('presentation-start', {
				fileId: fileId.toString(),
				userId: jwtPayload.userid,
			})

			// Add timeout to prevent getting stuck in "starting" state
			setTimeout(() => {
				if (status === 'starting') {
					console.warn('[Presentation] Timeout waiting for presentation-started event')
					setError('Failed to start presentation - timeout. Please try again.')
					setStatus('idle')
				}
			}, 10000) // 10 second timeout

		} catch (err) {
			console.error('[Presentation] Error starting presentation:', err)
			setError(err instanceof Error ? err.message : 'Failed to start presentation')
			setStatus('idle')
		}
	}, [socket, isConnected, isPresentationMode, presenterId, fileId, getJWT, parseJwt, status])

	// Stop presentation
	const stopPresentation = useCallback(async () => {
		if (!socket || !isConnected) {
			setError('Connection required to stop presentation')
			return
		}

		if (!isPresenting) {
			return
		}

		try {
			setStatus('stopping')
			setError(null)

			// Emit stop presentation event
			socket.emit('presentation-stop', {
				fileId: fileId.toString(),
			})

		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to stop presentation')
			setStatus('presenting')
		}
	}, [socket, isConnected, isPresenting, fileId])

	// Toggle auto-follow presenter
	const toggleAutoFollow = useCallback(() => {
		const newAutoFollow = !autoFollowPresenter
		setAutoFollowPresenter(newAutoFollow)

		// If enabling auto-follow and we have a presenter
		if (newAutoFollow && presenterId) {
			// Set followed user immediately to start following
			useCollaborationStore.setState({ followedUserId: presenterId })
			// console.log(`[Presentation] Enabled auto-follow for presenter: ${presenterId}`)

			// Request their viewport for immediate sync
			if (socket?.connected) {
				// console.log('[Presentation] Requesting presenter viewport for immediate sync')
				// Broadcast request to all users in the room - presenter will respond
				socket.emit('request-presenter-viewport', {
					fileId: fileId.toString(),
				})
			}
		} else if (!newAutoFollow && presenterId) {
			// Clear followed user when disabling auto-follow
			const currentFollowed = useCollaborationStore.getState().followedUserId
			if (currentFollowed === presenterId) {
				useCollaborationStore.setState({ followedUserId: null })
				// console.log('[Presentation] Disabled auto-follow')
			}
		}
	}, [autoFollowPresenter, setAutoFollowPresenter, presenterId, socket, fileId])

	// Reset error
	const resetError = useCallback(() => {
		setError(null)
	}, [])

	// Keyboard shortcut handler
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Cmd/Ctrl + Shift + P for presentation toggle
			if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'P') {
				event.preventDefault()
				if (isPresenting) {
					stopPresentation()
				} else if (isConnected && !isPresentationMode) {
					startPresentation()
				}
			}
		}

		document.addEventListener('keydown', handleKeyDown)
		return () => {
			document.removeEventListener('keydown', handleKeyDown)
		}
	}, [isPresenting, isConnected, isPresentationMode, startPresentation, stopPresentation])

	// Setup socket event listeners
	useEffect(() => {
		if (!socket) return

		const handlePresentationStarted = async () => {
			// eslint-disable-next-line no-console
			// console.log('[Presentation] Successfully started presenting - received presentation-started event')

			// Get current user info to set as presenter
			const jwt = await getJWT()
			const jwtPayload = jwt ? parseJwt(jwt) : null
			const currentUserId = jwtPayload?.userid

			// eslint-disable-next-line no-console
			// console.log('[Presentation] Setting presentation state:', {
			//  presenterId: currentUserId,
			//  isPresentationMode: true,
			//  isPresenting: true,
			//  presentationStartTime: Date.now(),
			// })

			setPresentationState({
				presenterId: currentUserId,
				isPresentationMode: true,
				isPresenting: true, // This user is now presenting
				presentationStartTime: Date.now(),
			})
			setStatus('presenting')
			setError(null)
		}

		const handlePresentationStopped = () => {
			// console.log('[Presentation] Presentation ended')

			// Clear auto-follow when presentation ends
			const currentState = useCollaborationStore.getState()
			if (currentState.followedUserId === presenterId) {
				// console.log('[Presentation] Clearing auto-follow (presentation ended)')
				useCollaborationStore.setState({ followedUserId: null })
			}

			setPresentationState({
				presenterId: null,
				isPresentationMode: false,
				isPresenting: false,
				presentationStartTime: null,
			})
			setPresenterName(null)
			setStatus('idle')
		}

		const handlePresentationError = (errorMessage: string) => {
			console.error('[Presentation] Error:', errorMessage)
			setError(errorMessage)
			setStatus('idle')
		}

		const handleUserStartedPresenting = (data: { userId: string; username: string }) => {
			// console.log(`[Presentation] User started presenting: ${data.username}`)
			setPresentationState({
				presenterId: data.userId,
				isPresentationMode: true,
				presentationStartTime: Date.now(),
			})
			setPresenterName(data.username)

			// If auto-follow is enabled, immediately follow the presenter and request their viewport
			const currentAutoFollow = useCollaborationStore.getState().autoFollowPresenter
			if (currentAutoFollow) {
				// console.log(`[Presentation] Auto-following new presenter: ${data.userId}`)
				useCollaborationStore.setState({ followedUserId: data.userId })

				// Request presenter's viewport for immediate sync
				if (socket?.connected) {
					// console.log('[Presentation] Requesting presenter viewport for new joiner')
					socket.emit('request-presenter-viewport', {
						fileId: fileId.toString(),
					})
				}
			}
		}

		const handleUserStoppedPresenting = () => {
			// console.log('[Presentation] User stopped presenting')

			// Clear auto-follow when presentation ends
			const currentState = useCollaborationStore.getState()
			if (currentState.followedUserId === presenterId) {
				// console.log('[Presentation] Clearing auto-follow (presenter stopped)')
				useCollaborationStore.setState({ followedUserId: null })
			}

			setPresentationState({
				presenterId: null,
				isPresentationMode: false,
				isPresenting: false,
				presentationStartTime: null,
			})
			setPresenterName(null)
		}

		// Handle connection events
		const handleConnect = () => {
			// console.log('[Presentation] Socket connected')
			// Reset any error states on reconnection
			setError(null)
		}

		const handleDisconnect = () => {
			// console.log('[Presentation] Socket disconnected')

			// Clear auto-follow on disconnect
			const currentState = useCollaborationStore.getState()
			if (currentState.followedUserId === presenterId) {
				// console.log('[Presentation] Clearing auto-follow (disconnected)')
				useCollaborationStore.setState({ followedUserId: null })
			}

			// Reset presentation state on disconnect
			if (isPresenting) {
				setPresentationState({
					isPresenting: false,
					isPresentationMode: false,
					presenterId: null,
					presentationStartTime: null,
				})
				setStatus('idle')
				setPresenterName(null)
			}
		}

		// Register event listeners
		// console.log('[Presentation] Registering socket event listeners')
		socket.on('connect', handleConnect)
		socket.on('disconnect', handleDisconnect)
		socket.on('presentation-started', handlePresentationStarted)
		socket.on('presentation-stopped', handlePresentationStopped)
		socket.on('presentation-error', handlePresentationError)
		socket.on('user-started-presenting', handleUserStartedPresenting)
		socket.on('user-stopped-presenting', handleUserStoppedPresenting)

		// Cleanup
		return () => {
			socket.off('connect', handleConnect)
			socket.off('disconnect', handleDisconnect)
			socket.off('presentation-started', handlePresentationStarted)
			socket.off('presentation-stopped', handlePresentationStopped)
			socket.off('presentation-error', handlePresentationError)
			socket.off('user-started-presenting', handleUserStartedPresenting)
			socket.off('user-stopped-presenting', handleUserStoppedPresenting)
		}
	}, [socket, setPresentationState])

	// This effect is removed - presentation-started is handled in the main socket effect above

	// Auto-follow presenter when presentation mode starts
	useEffect(() => {
		if (isPresentationMode && presenterId && autoFollowPresenter) {
			// Set the followed user ID to enable viewport following
			useCollaborationStore.setState({ followedUserId: presenterId })
			// console.log(`[Presentation] Auto-following presenter: ${presenterId}`)

			// Request presenter's viewport for immediate sync
			if (socket?.connected) {
				// console.log('[Presentation] Requesting presenter viewport on auto-follow enable')
				socket.emit('request-presenter-viewport', {
					fileId: fileId.toString(),
				})
			}
		} else if (!isPresentationMode) {
			// Clear followed user when presentation ends (unless manually set)
			const currentFollowed = useCollaborationStore.getState().followedUserId
			if (currentFollowed === presenterId) {
				useCollaborationStore.setState({ followedUserId: null })
				// console.log('[Presentation] Stopped auto-following (presentation ended)')
			}
		}
	}, [isPresentationMode, presenterId, autoFollowPresenter, socket, fileId])

	// Clear auto-follow when presenterId changes or becomes null
	useEffect(() => {
		const currentState = useCollaborationStore.getState()
		if (!presenterId && currentState.followedUserId) {
			// If there's no presenter but we're still following someone from a previous presentation
			const wasAutoFollowing = currentState.followedUserId !== null
			if (wasAutoFollowing) {
				// console.log('[Presentation] Clearing auto-follow (no active presenter)')
				useCollaborationStore.setState({ followedUserId: null })
			}
		}
	}, [presenterId])

	// Handle auto-follow toggle
	useEffect(() => {
		if (isPresentationMode && presenterId) {
			if (autoFollowPresenter) {
				useCollaborationStore.setState({ followedUserId: presenterId })
				// console.log(`[Presentation] Enabled auto-follow for presenter: ${presenterId}`)

				// Request presenter's current viewport for immediate sync
				if (socket?.connected) {
					// console.log('[Presentation] Requesting presenter viewport for immediate sync')
					socket.emit('request-presenter-viewport', {
						fileId: fileId.toString(),
					})
				}
			} else {
				// Only clear if we're following the presenter (not manually set)
				const currentFollowed = useCollaborationStore.getState().followedUserId
				if (currentFollowed === presenterId) {
					useCollaborationStore.setState({ followedUserId: null })
					// console.log('[Presentation] Disabled auto-follow')
				}
			}
		}
	}, [autoFollowPresenter, isPresentationMode, presenterId, socket, fileId])

	return {
		// State
		isPresenting,
		isPresentationMode,
		presenterId,
		presenterName,
		presentationStartTime,
		autoFollowPresenter,

		// Status
		status,
		error,
		isConnected,

		// Actions
		startPresentation,
		stopPresentation,
		toggleAutoFollow,
		resetError,
	}
}
