/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useShallow } from 'zustand/react/shallow'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'

type TimerStatus = 'idle' | 'running' | 'paused' | 'finished'

interface TimerUser {
	id: string
	name: string
}

interface TimerState {
	status: TimerStatus
	durationMs: number | null
	remainingMs: number
	endsAt: number | null
	startedBy: TimerUser | null
	pausedBy: TimerUser | null
	startedAt: number | null
	updatedAt: number | null
}

const INITIAL_TIMER_STATE: TimerState = {
	status: 'idle',
	durationMs: null,
	remainingMs: 0,
	endsAt: null,
	startedBy: null,
	pausedBy: null,
	startedAt: null,
	updatedAt: null,
}

function normalizeTime(value: number | undefined | null) {
	if (!Number.isFinite(value ?? 0)) {
		return 0
	}
	return Math.max(Math.floor(value ?? 0), 0)
}

function playFinishChime() {
	const maybeWindow = typeof window !== 'undefined' ? window : undefined
	const AudioContextCtor = typeof AudioContext !== 'undefined'
		? AudioContext
		: (maybeWindow as typeof window & { webkitAudioContext?: typeof AudioContext })?.webkitAudioContext

	if (!maybeWindow || !AudioContextCtor) {
		return
	}

	try {
		const context = new AudioContextCtor()
		const oscillator = context.createOscillator()
		const gainNode = context.createGain()

		oscillator.type = 'sine'
		oscillator.frequency.value = 880

		gainNode.gain.value = 0.1
		oscillator.connect(gainNode)
		gainNode.connect(context.destination)

		oscillator.start()
		setTimeout(() => {
			oscillator.stop()
			context.close()
		}, 500)
	} catch (error) {
		console.warn('[Timer] Unable to play finish sound:', error)
	}
}

interface UseTimerProps {
	fileId: number
}

export interface UseTimerResult extends TimerState {
	displayRemainingMs: number
	isConnected: boolean
	canControl: boolean
	error: string | null
	startTimer: (durationMs: number) => void
	pauseTimer: () => void
	resumeTimer: () => void
	resetTimer: () => void
	extendTimer: (additionalMs: number) => void
	clearError: () => void
}

export function useTimer({ fileId }: UseTimerProps): UseTimerResult {
	const [timerState, setTimerState] = useState<TimerState>(INITIAL_TIMER_STATE)
	const [displayRemainingMs, setDisplayRemainingMs] = useState(0)
	const [error, setError] = useState<string | null>(null)
	const lastFinishedAtRef = useRef<number | null>(null)

	const { socket, status: connectionStatus } = useCollaborationStore(useShallow(state => ({
		socket: state.socket,
		status: state.status,
	})))

	const { isReadOnly } = useWhiteboardConfigStore(useShallow(state => ({
		isReadOnly: state.isReadOnly,
	})))

	const isConnected = connectionStatus === 'online' && socket?.connected === true
	const fileIdStr = useMemo(() => fileId?.toString(), [fileId])

	const updateTimerState = useCallback((payload: Partial<TimerState>) => {
		setTimerState(prev => {
			const remainingSource = payload.remainingMs !== undefined ? payload.remainingMs : prev.remainingMs
			const durationSource = payload.durationMs !== undefined
				? payload.durationMs
				: (prev.durationMs ?? remainingSource)

			const normalizedDuration = durationSource === null ? null : normalizeTime(durationSource)

			return {
				...prev,
				...payload,
				remainingMs: normalizeTime(remainingSource),
				durationMs: normalizedDuration,
			}
		})
	}, [])

	useEffect(() => {
		if (timerState.status === 'running' && timerState.endsAt) {
			const update = () => {
				setDisplayRemainingMs(Math.max(timerState.endsAt! - Date.now(), 0))
			}

			update()
			const interval = window.setInterval(update, 250)
			return () => window.clearInterval(interval)
		}

		setDisplayRemainingMs(Math.max(timerState.remainingMs, 0))
	}, [timerState.status, timerState.endsAt, timerState.remainingMs])

	const handleTimerState = useCallback((payload: Partial<TimerState>) => {
		const endsAt = payload.status === 'running'
			? payload.endsAt ?? (payload.remainingMs ? Date.now() + payload.remainingMs : null)
			: null

		const baseReset = payload.status === 'idle' ? INITIAL_TIMER_STATE : {}

		updateTimerState({
			...baseReset,
			...payload,
			endsAt,
			status: payload.status ?? 'idle',
			updatedAt: payload.updatedAt ?? Date.now(),
		})

		if (payload.status === 'finished') {
			const finishStamp = payload.updatedAt ?? Date.now()
			if (!lastFinishedAtRef.current || finishStamp > lastFinishedAtRef.current) {
				lastFinishedAtRef.current = finishStamp
				showSuccess(t('whiteboard', 'Timer finished'))
				playFinishChime()
			}
		}
		setError(null)
	}, [updateTimerState])

	const handleTimerError = useCallback((message: string) => {
		const errorMessage = message || t('whiteboard', 'Unable to update timer')
		console.error('[Timer] Error:', errorMessage)
		setError(errorMessage)
		showError(errorMessage)
	}, [])

	const requestTimerState = useCallback(() => {
		if (!fileIdStr || !socket?.connected) {
			return
		}
		socket.emit('timer-state-request', { fileId: fileIdStr })
	}, [socket, fileIdStr])

	useEffect(() => {
		if (!socket) {
			return
		}

		socket.on('timer-state', handleTimerState)
		socket.on('timer-error', handleTimerError)

		if (socket.connected) {
			requestTimerState()
		}

		const handleConnect = () => {
			requestTimerState()
		}

		socket.on('connect', handleConnect)

		return () => {
			socket.off('timer-state', handleTimerState)
			socket.off('timer-error', handleTimerError)
			socket.off('connect', handleConnect)
		}
	}, [socket, handleTimerState, handleTimerError, requestTimerState])

	useEffect(() => {
		if (fileIdStr) {
			requestTimerState()
		}
	}, [fileIdStr, requestTimerState])

	const ensureCanControl = useCallback((action: string) => {
		if (!fileIdStr) {
			handleTimerError(t('whiteboard', 'Missing whiteboard identifier'))
			return false
		}
		if (isReadOnly) {
			handleTimerError(t('whiteboard', 'You need write access to control the timer'))
			return false
		}
		if (!isConnected || !socket) {
			handleTimerError(t('whiteboard', 'Timer requires a collaboration connection'))
			return false
		}
		console.debug(`[Timer] Proceeding with action "${action}"`)
		return true
	}, [fileIdStr, isReadOnly, isConnected, socket, handleTimerError])

	const startTimer = useCallback((durationMs: number) => {
		if (!ensureCanControl('start')) return

		const normalized = normalizeTime(durationMs)
		if (normalized === 0) {
			handleTimerError(t('whiteboard', 'Choose a duration to start the timer'))
			return
		}

		socket!.emit('timer-start', { fileId: fileIdStr, durationMs: normalized })
	}, [ensureCanControl, handleTimerError, socket, fileIdStr])

	const pauseTimer = useCallback(() => {
		if (!ensureCanControl('pause')) return
		socket!.emit('timer-pause', { fileId: fileIdStr })
	}, [ensureCanControl, socket, fileIdStr])

	const resumeTimer = useCallback(() => {
		if (!ensureCanControl('resume')) return
		socket!.emit('timer-resume', { fileId: fileIdStr })
	}, [ensureCanControl, socket, fileIdStr])

	const resetTimer = useCallback(() => {
		if (!ensureCanControl('reset')) return
		socket!.emit('timer-reset', { fileId: fileIdStr })
	}, [ensureCanControl, socket, fileIdStr])

	const extendTimer = useCallback((additionalMs: number) => {
		if (!ensureCanControl('extend')) return

		const normalized = normalizeTime(additionalMs)
		if (normalized === 0) {
			return
		}

		socket!.emit('timer-extend', { fileId: fileIdStr, additionalMs: normalized })
	}, [ensureCanControl, socket, fileIdStr])

	const clearError = useCallback(() => setError(null), [])

	return {
		...timerState,
		displayRemainingMs,
		isConnected,
		canControl: isConnected && !isReadOnly,
		error,
		startTimer,
		pauseTimer,
		resumeTimer,
		resetTimer,
		extendTimer,
		clearError,
	}
}
