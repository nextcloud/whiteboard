/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useEffect, useState, useCallback, useRef } from 'react'
import { Collab } from '../collaboration/collab'
import type { Socket } from 'socket.io-client'

interface UseRecordingProps {
	fileId: number
	collab: Collab | null
}

interface RecordingUser {
	userId: string
	username: string
}

type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping'

interface RecordingState {
	isRecording: boolean
	error: string | null
	startTime: number | null
	status: RecordingStatus
	duration: number | null
	otherUsers: RecordingUser[]
	fileUrl: string | null
	showSuccess: boolean
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
}

export function formatDuration(ms: number) {
	const seconds = Math.floor(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function useRecording({ fileId, collab }: UseRecordingProps) {
	const [state, setState] = useState<RecordingState>(INITIAL_STATE)
	const durationIntervalRef = useRef<NodeJS.Timeout | null>(null)
	const successTimeoutRef = useRef<NodeJS.Timeout | null>(null)

	const updateState = useCallback((updates: Partial<RecordingState>) => {
		setState(prev => ({ ...prev, ...updates }))
	}, [])

	const clearDurationInterval = useCallback(() => {
		if (durationIntervalRef.current) {
			clearInterval(durationIntervalRef.current)
			durationIntervalRef.current = null
		}
	}, [])

	const clearSuccessTimeout = useCallback(() => {
		if (successTimeoutRef.current) {
			clearTimeout(successTimeoutRef.current)
			successTimeoutRef.current = null
		}
	}, [])

	useEffect(() => {
		return () => {
			clearDurationInterval()
			clearSuccessTimeout()
		}
	}, [clearDurationInterval, clearSuccessTimeout])

	// Duration tracking
	useEffect(() => {
		clearDurationInterval()

		if (state.isRecording && state.startTime) {
			durationIntervalRef.current = setInterval(() => {
				updateState({ duration: state.startTime ? Date.now() - state.startTime : null })
			}, 1000)
		}

		return clearDurationInterval
	}, [state.isRecording, state.startTime, clearDurationInterval, updateState])

	const setupSocketListeners = useCallback((socket: Socket) => {
		console.log('Setting up recording event listeners for socket:', socket.id)

		const cleanupEvents = [
			'recording-started',
			'recording-stopped',
			'recording-error',
			'user-started-recording',
			'user-stopped-recording',
			'connect',
			'disconnect',
		]

		// Remove existing listeners
		cleanupEvents.forEach(event => socket.off(event))

		socket.on('recording-started', () => {
			console.log('[Recording] Started event received')
			updateState({
				isRecording: true,
				error: null,
				status: 'recording',
				startTime: Date.now(),
				fileUrl: null,
				showSuccess: false,
			})
		})

		socket.on('recording-stopped', (data: { filePath: string; fileUrl: string }) => {
			console.log('[Recording] Stopped event received with data:', data)
			clearSuccessTimeout()
			updateState({
				isRecording: false,
				error: null,
				status: 'idle',
				startTime: null,
				duration: null,
				fileUrl: data.fileUrl,
				showSuccess: true,
			})

			// Hide success message after 10 seconds
			successTimeoutRef.current = setTimeout(() => {
				updateState({ showSuccess: false })
			}, 10000)
		})

		socket.on('recording-error', (error: string) => {
			console.error('[Recording] Error event received:', error)
			updateState({
				isRecording: false,
				error,
				status: 'idle',
				startTime: null,
				duration: null,
			})
		})

		socket.on('user-started-recording', (user: RecordingUser) => {
			console.log('[Recording] User started recording:', user)
			updateState({
				otherUsers: [...state.otherUsers, user],
			})
		})

		socket.on('user-stopped-recording', (user: RecordingUser) => {
			console.log('[Recording] User stopped recording:', user)
			updateState({
				otherUsers: state.otherUsers.filter(u => u.userId !== user.userId),
			})
		})

		socket.on('connect', () => {
			console.log('[Recording] Socket connected:', socket.id)
			setupSocketListeners(socket)
		})

		socket.on('disconnect', () => {
			console.log('[Recording] Socket disconnected')
			if (state.isRecording) {
				updateState({
					error: 'Connection lost',
					status: 'idle',
				})
			}
		})

		console.log('[Recording] Event listeners registered')
	}, [state.otherUsers, state.isRecording, updateState, clearSuccessTimeout])

	// Socket event handling
	useEffect(() => {
		const socket = collab?.portal.socket
		if (socket) {
			setupSocketListeners(socket)
		}

		return () => {
			if (socket) {
				['recording-started', 'recording-stopped', 'recording-error',
					'user-started-recording', 'user-stopped-recording',
					'connect', 'disconnect'].forEach(event => socket.off(event))
			}
		}
	}, [collab?.portal.socket, setupSocketListeners])

	const startRecording = useCallback(async () => {
		const socket = collab?.portal.socket
		if (!socket) {
			updateState({
				error: 'Not connected to collaboration server',
				status: 'idle',
			})
			return
		}

		try {
			console.log('[Recording] Starting recording for fileId:', fileId)
			updateState({ status: 'starting' })
			socket.emit('start-recording', fileId)
		} catch (error) {
			console.error('[Recording] Error starting recording:', error)
			updateState({
				error: error instanceof Error ? error.message : 'Failed to start recording',
				status: 'idle',
			})
		}
	}, [collab?.portal.socket, fileId, updateState])

	const stopRecording = useCallback(async () => {
		const socket = collab?.portal.socket
		if (!socket) {
			updateState({
				error: 'Not connected to collaboration server',
				status: 'idle',
			})
			return
		}

		try {
			console.log('[Recording] Stopping recording')
			updateState({ status: 'stopping' })
			socket.emit('stop-recording', fileId)
		} catch (error) {
			console.error('[Recording] Error stopping recording:', error)
			updateState({
				error: error instanceof Error ? error.message : 'Failed to stop recording',
				status: 'idle',
			})
		}
	}, [collab?.portal.socket, fileId, updateState])

	const resetError = useCallback(() => {
		updateState({
			error: null,
			status: 'idle',
		})
	}, [updateState])

	const dismissSuccess = useCallback(() => {
		clearSuccessTimeout()
		updateState({ showSuccess: false })
	}, [clearSuccessTimeout, updateState])

	return {
		// Status information
		status: state.status,
		isRecording: state.isRecording,
		isStarting: state.status === 'starting',
		isStopping: state.status === 'stopping',
		hasError: !!state.error,

		// Time information
		startTime: state.startTime,
		duration: state.duration,

		// Error information
		error: state.error,

		// Success information
		fileUrl: state.fileUrl,
		showSuccess: state.showSuccess,

		// Other users recording
		otherRecordingUsers: state.otherUsers,
		hasOtherRecordingUsers: state.otherUsers.length > 0,

		// Actions
		startRecording,
		stopRecording,
		resetError,
		dismissSuccess,
	}
}
