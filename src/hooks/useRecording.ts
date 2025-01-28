/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

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

interface UseRecordingActions {
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	resetError: () => void
	dismissSuccess: () => void
}

const SOCKET_EVENTS = [
	'recording-started',
	'recording-stopped',
	'recording-error',
	'user-started-recording',
	'user-stopped-recording',
	'connect',
	'disconnect',
] as const

export function useRecording({ fileId, collab }: UseRecordingProps): RecordingState & UseRecordingActions {
	const [state, setState] = useState<RecordingState>(INITIAL_STATE)
	const durationIntervalRef = useRef<NodeJS.Timeout | null>(null)
	const successTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const stateRef = useRef(state)
	stateRef.current = state

	const updateState = useCallback((updates: Partial<RecordingState>) => {
		setState(prev => ({ ...prev, ...updates }))
	}, [])

	const clearTimers = useCallback(() => {
		durationIntervalRef.current && clearInterval(durationIntervalRef.current)
		successTimeoutRef.current && clearTimeout(successTimeoutRef.current)
	}, [])

	useEffect(() => () => clearTimers(), [clearTimers])

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
		socket: Socket,
		handlers: Record<string, (...args: any[]) => void>,
	) => {
		SOCKET_EVENTS.forEach(event => socket.off(event))
		Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler))
	}, [])

	const setupSocketListeners = useCallback((socket: Socket) => {
		handleSocketEvent(socket, {
			'recording-started': () => {
				updateState({
					isRecording: true,
					error: null,
					status: 'recording',
					startTime: Date.now(),
					fileUrl: null,
					showSuccess: false,
				})
			},
			'recording-stopped': (data: { filePath: string; fileUrl: string }) => {
				clearTimers()
				updateState({
					isRecording: false,
					status: 'idle',
					startTime: null,
					duration: null,
					fileUrl: data.fileUrl,
					showSuccess: true,
				})
				successTimeoutRef.current = setTimeout(() => updateState({ showSuccess: false }), 10000)
			},
			'recording-error': (error: string) => updateState({
				isRecording: false,
				error,
				status: 'idle',
				startTime: null,
				duration: null,
			}),
			'user-started-recording': (user: RecordingUser) => updateState({
				otherUsers: [...stateRef.current.otherUsers, user],
			}),
			'user-stopped-recording': (user: RecordingUser) => updateState({
				otherUsers: stateRef.current.otherUsers.filter(u => u.userId !== user.userId),
			}),
			connect: () => handleSocketEvent(socket, socket.eventNames()),
			disconnect: () => stateRef.current.isRecording && updateState({ error: 'Connection lost', status: 'idle' }),
		})
	}, [handleSocketEvent, updateState, clearTimers])

	useEffect(() => {
		const socket = collab?.portal.socket
		if (!socket) return

		setupSocketListeners(socket)
		return () => SOCKET_EVENTS.forEach(event => socket.off(event))
	}, [collab?.portal.socket, setupSocketListeners])

	const handleRecordingAction = useCallback(async (action: 'start' | 'stop') => {
		const socket = collab?.portal.socket
		if (!socket) {
			updateState({ error: 'Not connected to collaboration server', status: 'idle' })
			return
		}

		try {
			updateState({ status: `${action}ing` as RecordingStatus })
			socket.emit(`${action}-recording`, fileId)
		} catch (error) {
			updateState({
				error: error instanceof Error ? error.message : `Failed to ${action} recording`,
				status: 'idle',
			})
		}
	}, [collab?.portal.socket, fileId, updateState])

	const startRecording = useCallback(() => handleRecordingAction('start'), [handleRecordingAction])
	const stopRecording = useCallback(() => handleRecordingAction('stop'), [handleRecordingAction])

	return {
		...state,
		hasError: !!state.error,
		isStarting: state.status === 'starting',
		isStopping: state.status === 'stopping',
		hasOtherRecordingUsers: state.otherUsers.length > 0,
		startRecording,
		stopRecording,
		resetError: () => updateState({ error: null, status: 'idle' }),
		dismissSuccess: () => {
			clearTimers()
			updateState({ showSuccess: false })
		},
	}
}
