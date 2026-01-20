/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useShallow } from 'zustand/react/shallow'
import { generateUrl } from '@nextcloud/router'
import type { CollaborationSocket } from '../types/collaboration'
import type { RecordingHookState, RecordingState, RecordingUser } from '../types/recording'
import { t } from '@nextcloud/l10n'

interface UseRecordingProps {
	fileId: number
}

const INITIAL_STATE: RecordingState = {
	isRecording: false,
	error: null,
	startTime: null,
	status: 'idle',
	duration: null,
	otherUsers: [],
	fileUrl: null,
	showSuccess: false,
	isUploading: false,
	filename: null,
	recordingDuration: null,
	successTimestamp: null,
	startingPhase: null,
	isAvailable: null,
	unavailableReason: null,
	showUnavailableInfo: false,
}

export function formatDuration(ms: number) {
	const seconds = Math.floor(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

const SOCKET_EVENTS = [
	'recording-started',
	'recording-stopped',
	'recording-error',
	'recording-availability',
	'user-started-recording',
	'user-stopped-recording',
	'connect',
	'disconnect',
] as const
type RecordingSocketEvent = typeof SOCKET_EVENTS[number]

export function useRecording({ fileId }: UseRecordingProps): RecordingHookState {
	const [state, setState] = useState<RecordingState>(INITIAL_STATE)
	const durationIntervalRef = useRef<NodeJS.Timeout | null>(null)
	const successTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const stateRef = useRef(state)
	stateRef.current = state
	const currentUserIdRef = useRef<string | null>(null)

	const { socket, status } = useCollaborationStore(useShallow(state => ({
		socket: state.socket as CollaborationSocket | null,
		status: state.status,
	})))

	const isConnected = status === 'online' && socket?.connected === true

	const updateState = useCallback((updates: Partial<RecordingState>) => {
		console.log('[Recording] State update:', updates)
		setState(prev => {
			const newState = { ...prev, ...updates }
			console.log('[Recording] New state:', newState)
			return newState
		})
	}, [])

	const clearTimers = useCallback(() => {
		console.log('[Recording] Clearing timers...')
		if (durationIntervalRef.current) {
			console.log('[Recording] Clearing duration interval')
			clearInterval(durationIntervalRef.current)
		}
		if (successTimeoutRef.current) {
			console.log('[Recording] Clearing success timeout')
			clearTimeout(successTimeoutRef.current)
		}
	}, [])

	useEffect(() => () => clearTimers(), [clearTimers])

	const resolveCurrentUserId = useCallback(async () => {
		if (currentUserIdRef.current) {
			return currentUserIdRef.current
		}

		try {
			const jwt = await useJWTStore.getState().getJWT()
			if (!jwt) {
				return null
			}
			const payload = useJWTStore.getState().parseJwt(jwt)
			const userId = payload?.user?.id || payload?.userid || null
			currentUserIdRef.current = userId
			return userId
		} catch (error) {
			console.error('[Recording] Failed to resolve current user ID:', error)
			return null
		}
	}, [])

	useEffect(() => {
		currentUserIdRef.current = null
		resolveCurrentUserId().catch((error) => {
			console.error('[Recording] Failed to prime current user ID:', error)
		})
	}, [fileId, resolveCurrentUserId])

	// Duration tracking
	useEffect(() => {
		clearInterval(durationIntervalRef.current!)

		if (state.isRecording && state.startTime) {
			durationIntervalRef.current = setInterval(() => {
				updateState({ duration: Date.now() - stateRef.current.startTime! })
			}, 1000)
		}
	}, [state.isRecording, state.startTime, updateState])

	const handleSocketEvent = useCallback((
		socketInstance: CollaborationSocket,
		handlers: Partial<Record<RecordingSocketEvent, (...args: unknown[]) => void | Promise<void>>>,
	) => {
		SOCKET_EVENTS.forEach(event => socketInstance.off(event))
		Object.entries(handlers).forEach(([event, handler]) => {
			if (handler) {
				socketInstance.on(event as RecordingSocketEvent, (...args: unknown[]) => {
					const result = handler(...args)
					if (result instanceof Promise) {
						result.catch((err) => {
							console.error('[Recording] Socket handler error:', err)
						})
					}
				})
			}
		})
	}, [])

	const setupSocketListeners = useCallback((socketInstance: CollaborationSocket) => {
		// Check recording availability when socket connects
		socketInstance.emit('check-recording-availability')

		handleSocketEvent(socketInstance, {
			'recording-availability': (data) => {
				console.log('[Recording] Availability check result:', data)
				updateState({
					isAvailable: data.available,
					unavailableReason: data.reason,
					// Show info dialog if recording is unavailable and we have a reason
					showUnavailableInfo: data.available === false && !!data.reason,
				})
			},
			'recording-started': (data?: { startedAt?: number }) => {
				const startTime = typeof data?.startedAt === 'number' ? data.startedAt : Date.now()
				updateState({
					isRecording: true,
					error: null,
					status: 'recording',
					startTime,
					duration: Math.max(0, Date.now() - startTime),
					fileUrl: null,
					showSuccess: false,
					startingPhase: null,
				})
			},
			'recording-stopped': async (data: { filePath: string; recordingData: number[]; uploadToken: string; fileId: string }) => {
				console.log('[Recording] Recording stopped event received:', data)
				// Only clear the duration interval, not the success timeout
				if (durationIntervalRef.current) {
					console.log('[Recording] Clearing duration interval only')
					clearInterval(durationIntervalRef.current)
					durationIntervalRef.current = null
				}

				// Store recording duration before clearing state
				const recordingDuration = stateRef.current.duration
				console.log('[Recording] Stored recording duration:', recordingDuration)

				// Show upload status immediately
				console.log('[Recording] Setting upload state...')
				updateState({
					isRecording: false,
					status: 'idle',
					startTime: null,
					duration: null,
					isUploading: true,
					recordingDuration,
					showSuccess: false,
					error: null,
				})
				console.log('[Recording] Upload state set, starting upload...')

				try {
					const { publicSharingToken } = useWhiteboardConfigStore.getState()
					const isGuestUser = !!publicSharingToken

					if (isGuestUser) {
						// Guest user: auto-download recording
						console.log('[Recording] Guest user - auto-downloading recording')
						const blob = new Blob([new Uint8Array(data.recordingData)], { type: 'video/webm' })
						const url = URL.createObjectURL(blob)
						const link = document.createElement('a')
						link.href = url
						link.download = `whiteboard_${data.fileId}_${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')}.webm`
						document.body.appendChild(link)
						link.click()
						document.body.removeChild(link)
						URL.revokeObjectURL(url)

						console.log('[Recording] Auto-download completed')
					} else {
						// Authenticated user: upload to server
						console.log('[Recording] Authenticated user - uploading to server')
						const blob = new Blob([new Uint8Array(data.recordingData)], { type: 'video/webm' })
						const formData = new FormData()
						formData.append('recording', blob, 'recording.webm')

						const uploadUrl = generateUrl(`apps/whiteboard/recording/${data.fileId}/upload`)

						const uploadResponse = await fetch(uploadUrl, {
							method: 'POST',
							headers: {
								Authorization: `Bearer ${data.uploadToken}`,
								requesttoken: (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement)?.content || '',
							},
							body: formData,
						})

						if (!uploadResponse.ok) {
							throw new Error(`Upload failed: ${uploadResponse.statusText}`)
						}

						const uploadResult = await uploadResponse.json()
						console.log('[Recording] Upload successful, result:', uploadResult)

						console.log('[Recording] Setting success state...')
						const successTime = Date.now()
						updateState({
							isUploading: false,
							fileUrl: uploadResult.fileUrl,
							filename: uploadResult.filename,
							showSuccess: true,
							successTimestamp: successTime,
						})
					}

					const successTime = Date.now()
					if (isGuestUser) {
						// For guest users, just show success without file URL
						console.log('[Recording] Setting guest success state...')
						const successTime = Date.now()
						updateState({
							isUploading: false,
							showSuccess: true,
							successTimestamp: successTime,
						})
					}
					console.log('[Recording] Success state set, scheduling auto-dismiss in 30 seconds...')
					// Clear any existing timeout first
					if (successTimeoutRef.current) {
						clearTimeout(successTimeoutRef.current)
					}
					successTimeoutRef.current = setTimeout(() => {
						console.log('[Recording] Auto-dismissing success message after 30 seconds - timeout fired')
						console.log('[Recording] Current time:', Date.now())
						console.log('[Recording] Success timestamp was:', successTime)
						console.log('[Recording] Time elapsed:', Date.now() - successTime, 'ms')
						// Only dismiss if enough time has actually passed
						if (Date.now() - successTime >= 29000) { // Allow 1 second tolerance
							updateState({ showSuccess: false, successTimestamp: null })
						} else {
							console.log('[Recording] Not enough time elapsed, keeping success message')
						}
					}, 30000) // 30 seconds
					console.log('[Recording] Timeout set at time:', Date.now())
					console.log('[Recording] Timeout scheduled with ID:', successTimeoutRef.current)
				} catch (error) {
					console.error('[Recording] Failed to upload recording:', error)
					console.log('[Recording] Setting error state...')
					updateState({
						isUploading: false,
						error: error instanceof Error ? error.message : 'Failed to upload recording',
					})
				}
			},
			'recording-error': (error: string) => updateState({
				isRecording: false,
				error,
				status: 'idle',
				startTime: null,
				duration: null,
			}),
			'user-started-recording': async (user: RecordingUser) => {
				const currentUserId = await resolveCurrentUserId()
				if (currentUserId && user.userId === currentUserId) {
					return
				}
				const username = user.username?.trim() || 'Unknown user'
				const sanitizedUser: RecordingUser = { ...user, username }
				const alreadyTracked = stateRef.current.otherUsers.some(u => u.userId === user.userId)
				if (alreadyTracked) {
					return
				}
				updateState({
					otherUsers: [...stateRef.current.otherUsers, sanitizedUser],
				})
			},
			'user-stopped-recording': (user: RecordingUser) => updateState({
				otherUsers: stateRef.current.otherUsers.filter(u => u.userId !== user.userId),
			}),
			connect: () => {
				// Socket reconnected, check availability again
				console.log('[Recording] Socket reconnected, checking availability')
				socketInstance.emit('check-recording-availability')
			},
			disconnect: () => stateRef.current.isRecording && updateState({ error: 'Connection lost', status: 'idle' }),
		})
	}, [handleSocketEvent, updateState, clearTimers, resolveCurrentUserId])

	useEffect(() => {
		if (!socket) return

		setupSocketListeners(socket)
		return () => SOCKET_EVENTS.forEach(event => socket.off(event))
	}, [socket, setupSocketListeners])

	const handleRecordingAction = useCallback(async (action: 'start' | 'stop') => {
		// Check connection status at the time of action, not when callback was created
		const currentStatus = useCollaborationStore.getState().status
		const currentSocket = useCollaborationStore.getState().socket
		const currentIsConnected = currentStatus === 'online' && currentSocket?.connected === true

		console.log('[Recording] Action connection check:', {
			action,
			currentStatus,
			socketExists: !!currentSocket,
			socketConnected: currentSocket?.connected,
			currentIsConnected,
		})

		if (!currentSocket || !currentIsConnected) {
			updateState({
				error: t('whiteboard', 'Recording requires connection to collaboration server. Please check your network connection.'),
				status: 'idle',
			})
			return
		}

		try {
			updateState({
				status: action === 'start' ? 'starting' : 'stopping',
				startingPhase: action === 'start' ? 'preparing' : null,
			})

			if (action === 'start') {
				// Use existing JWT and generate recording URL directly
				const jwt = await useJWTStore.getState().getJWT()

				if (!jwt) {
					throw new Error('Authentication required for recording')
				}

				// Get user ID from JWT payload
				const jwtPayload = useJWTStore.getState().parseJwt(jwt)
				if (!jwtPayload?.userid) {
					throw new Error('Invalid JWT token')
				}

				// Generate recording URL using existing JWT (absolute URL for Puppeteer)
				const relativeUrl = generateUrl(`apps/whiteboard/recording/${fileId}/${jwtPayload.userid}`)
				const recordingUrl = `${window.location.origin}${relativeUrl}?token=${jwt}`

				// Tell Node.js to start recording with the URL and existing JWT
				updateState({ startingPhase: 'initializing' })
				currentSocket.emit('start-recording', {
					fileId,
					recordingUrl,
					uploadToken: jwt,
				})
			} else {
				// For stop, just emit to Node.js
				currentSocket.emit('stop-recording', fileId.toString())
			}
		} catch (error) {
			updateState({
				error: error instanceof Error ? error.message : `Failed to ${action} recording`,
				status: 'idle',
				startingPhase: null,
			})
		}
	}, [fileId, updateState])

	const startRecording = useCallback(() => handleRecordingAction('start'), [handleRecordingAction])
	const stopRecording = useCallback(() => handleRecordingAction('stop'), [handleRecordingAction])

	return {
		...state,
		hasError: !!state.error,
		isStarting: state.status === 'starting',
		isStopping: state.status === 'stopping',
		hasOtherRecordingUsers: state.otherUsers.length > 0,
		isConnected,
		startRecording,
		stopRecording,
		resetError: () => updateState({ error: null, status: 'idle' }),
		dismissSuccess: () => {
			console.log('[Recording] dismissSuccess called manually')
			if (successTimeoutRef.current) {
				console.log('[Recording] Clearing success timeout manually')
				clearTimeout(successTimeoutRef.current)
				successTimeoutRef.current = null
			}
			updateState({ showSuccess: false, successTimestamp: null })
		},
		dismissUnavailableInfo: () => updateState({ showUnavailableInfo: false }),
	}
}
