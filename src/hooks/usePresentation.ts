/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback, useEffect, useRef, useState } from 'react'
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
		setAutoFollowPresenter(!autoFollowPresenter)
	}, [autoFollowPresenter, setAutoFollowPresenter])

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
		}

		const handleUserStoppedPresenting = () => {
			// console.log('[Presentation] User stopped presenting')

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

	const lastPresenterIdRef = useRef<string | null>(null)

	useEffect(() => {
		const currentFollowed = useCollaborationStore.getState().followedUserId
		const lastPresenterId = lastPresenterIdRef.current
		lastPresenterIdRef.current = presenterId

		if (!isPresentationMode || !presenterId) {
			const targetId = presenterId || lastPresenterId
			if (targetId && currentFollowed === targetId) {
				useCollaborationStore.setState({ followedUserId: null })
			}
			return
		}

		if (!autoFollowPresenter) {
			if (currentFollowed === presenterId) {
				useCollaborationStore.setState({ followedUserId: null })
			}
			return
		}

		if (currentFollowed !== presenterId) {
			useCollaborationStore.setState({ followedUserId: presenterId })
			if (socket?.connected) {
				socket.emit('request-presenter-viewport', {
					fileId: fileId.toString(),
				})
			}
		}
	}, [isPresentationMode, presenterId, autoFollowPresenter, socket, fileId])

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
