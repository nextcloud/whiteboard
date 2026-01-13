/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@mdi/react'
import {
	mdiTimerOutline,
	mdiPause,
	mdiPlay,
	mdiRestart,
	mdiPlus,
} from '@mdi/js'
import { DraggableDialog } from './DraggableDialog'
import type { UseTimerResult } from '../hooks/useTimer'
import { t } from '@nextcloud/l10n'
import './Timer.scss'

const MAX_DURATION_MS = 4 * 60 * 60 * 1000
const DIGIT_STRIP_RE = /[^\d]/g
const LEADING_ZERO_RE = /^0+(?=\d)/

function formatCountdown(ms: number) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000))
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60

	const parts = [
		hours > 0 ? hours.toString() : null,
		(minutes).toString().padStart(hours > 0 ? 2 : 1, '0'),
		seconds.toString().padStart(2, '0'),
	].filter(Boolean)

	return parts.join(':')
}

function splitDuration(ms: number) {
	const safeMs = Math.max(0, Math.min(ms, MAX_DURATION_MS))
	const totalSeconds = Math.floor(safeMs / 1000)
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60

	return { hours, minutes, seconds }
}

function normalizeTimeInput(value: string) {
	return value.replace(DIGIT_STRIP_RE, '').replace(LEADING_ZERO_RE, '')
}

interface TimerOverlayProps {
	timer: UseTimerResult
}

export const TimerOverlay = memo(function TimerOverlay({ timer }: TimerOverlayProps) {
	const [timeInputs, setTimeInputs] = useState(splitDuration(0))

	const formattedTime = useMemo(() => formatCountdown(timer.displayRemainingMs), [timer.displayRemainingMs])
	const isRunning = timer.status === 'running'
	const isPaused = timer.status === 'paused'
	const isFinished = timer.status === 'finished'
	const isIdle = timer.status === 'idle'
	const canControl = timer.canControl && timer.isConnected

	const setTimeFromMs = useCallback((durationMs: number) => {
		setTimeInputs(splitDuration(durationMs))
	}, [])

	useEffect(() => {
		if (timer.durationMs !== null && timer.durationMs !== undefined) {
			setTimeFromMs(timer.durationMs)
			return
		}

		if (timer.status === 'idle' && timer.durationMs === null && timer.remainingMs === 0) {
			setTimeFromMs(0)
		}
	}, [timer.durationMs, timer.remainingMs, timer.status, setTimeFromMs])

	const handleTimeChange = useCallback((part: keyof typeof timeInputs, value: string) => {
		const normalized = normalizeTimeInput(value)
		const numericValue = normalized === '' ? 0 : Number(normalized)

		setTimeInputs(prev => {
			const hours = part === 'hours' ? numericValue : prev.hours
			const minutes = part === 'minutes' ? numericValue : prev.minutes
			const seconds = part === 'seconds' ? numericValue : prev.seconds

			return splitDuration((Math.max(0, Math.floor(hours)) * 3600
				+ Math.max(0, Math.floor(minutes)) * 60
				+ Math.max(0, Math.floor(seconds))) * 1000)
		})
	}, [])

	const totalInputMs = useMemo(() => (
		(timeInputs.hours * 3600 + timeInputs.minutes * 60 + timeInputs.seconds) * 1000
	), [timeInputs])

	const hasInput = totalInputMs > 0

	const statusLabel = useMemo(() => {
		if (!timer.isConnected) {
			return t('whiteboard', 'Timer offline')
		}
		if (isRunning) {
			return t('whiteboard', 'Running')
		}
		if (isPaused) {
			return t('whiteboard', 'Paused')
		}
		if (isFinished) {
			return t('whiteboard', 'Finished')
		}
		return t('whiteboard', 'Ready')
	}, [timer.isConnected, isRunning, isPaused, isFinished])

	const startedByLabel = timer.startedBy?.name && !isIdle
		? `${t('whiteboard', 'Started by')} ${timer.startedBy.name}`
		: ''

	const handleStart = () => timer.startTimer(Math.min(totalInputMs, MAX_DURATION_MS))
	const handlePauseResume = () => {
		if (isRunning) {
			timer.pauseTimer()
		} else {
			timer.resumeTimer()
		}
	}
	const handleReset = () => {
		setTimeInputs(splitDuration(0))
		timer.resetTimer()
	}
	const handleExtend = (minutes: number) => timer.extendTimer(minutes * 60 * 1000)

	const controlVariant = isRunning
		? 'running'
		: isPaused
			? 'paused'
			: hasInput
				? 'start'
				: 'presets'

	const initialPosition = useMemo(() => ({
		x: typeof window !== 'undefined' ? Math.max(window.innerWidth - 420, 20) : 20,
		y: 90,
	}), [])

	return (
		<div className="timer-overlay">
			<DraggableDialog
				id="whiteboard-timer"
				initialPosition={initialPosition}
				enableDrag={true}>
				<div className="timer">
					<div className="timer__header">
						<div className="timer__title">
							<Icon path={mdiTimerOutline} size={1} />
							<span>{t('whiteboard', 'Timer')}</span>
						</div>
						<div className={`timer__status timer__status--${timer.status}`}>
							<div className="timer__status-line">
								<span className="timer__status-dot" />
								<span className="timer__status-text">{statusLabel}</span>
							</div>
							{startedByLabel && (
								<small className="timer__status-sub">{startedByLabel}</small>
							)}
						</div>
					</div>

					<div className="timer__display">
						<div className={`timer__time ${isFinished ? 'timer__time--finished' : ''}`}>
							{(isRunning || isPaused)
								? (
									formattedTime
								)
								: (
									<div className="timer__time-inputs">
										<div className="timer__time-input-wrapper" data-label="hh">
											<input
												id="timer-hours"
												type="text"
												inputMode="numeric"
												pattern="[0-9]*"
												value={timeInputs.hours}
												onChange={(event) => handleTimeChange('hours', event.target.value)}
												disabled={!canControl}
												aria-label={t('whiteboard', 'Hours')}
												className="timer__time-input"
											/>
										</div>
										<span className="timer__time-separator">:</span>
										<div className="timer__time-input-wrapper" data-label="mm">
											<input
												id="timer-minutes"
												type="text"
												inputMode="numeric"
												pattern="[0-9]*"
												value={timeInputs.minutes}
												onChange={(event) => handleTimeChange('minutes', event.target.value)}
												disabled={!canControl}
												aria-label={t('whiteboard', 'Minutes')}
												className="timer__time-input"
											/>
										</div>
										<span className="timer__time-separator">:</span>
										<div className="timer__time-input-wrapper" data-label="ss">
											<input
												id="timer-seconds"
												type="text"
												inputMode="numeric"
												pattern="[0-9]*"
												value={timeInputs.seconds}
												onChange={(event) => handleTimeChange('seconds', event.target.value)}
												disabled={!canControl}
												aria-label={t('whiteboard', 'Seconds')}
												className="timer__time-input"
											/>
										</div>
									</div>
								)}
						</div>
						{!timer.isConnected && (
							<div className="timer__offline">{t('whiteboard', 'Waiting for connection…')}</div>
						)}
					</div>

					<div className="timer__controls">
						<div className="timer__controls-content" key={controlVariant}>
							{controlVariant === 'presets' && (
								<div className="timer__grid timer__grid--presets">
									{[1, 5, 10, 15].map((minutes) => (
										<button
											key={minutes}
											className="timer__chip"
											disabled={!canControl}
											onClick={() => {
												const presetMs = Math.min(minutes * 60 * 1000, MAX_DURATION_MS)
												setTimeFromMs(presetMs)
												timer.startTimer(presetMs)
											}}>
											{`${minutes} ${t('whiteboard', 'min')}`}
										</button>
									))}
								</div>
							)}

							{controlVariant === 'start' && (
								<div className="timer__grid timer__grid--primary">
									<button
										className="timer__button timer__button--start timer__button--block"
										onClick={handleStart}
										disabled={!canControl || totalInputMs <= 0}>
										<Icon path={mdiPlay} size={0.8} />
										{t('whiteboard', 'Start')}
									</button>
									<button
										className="timer__button timer__button--ghost timer__button--block"
										onClick={handleReset}
										disabled={!canControl}>
										<Icon path={mdiRestart} size={0.8} />
										<span className="timer__button-label">{t('whiteboard', 'Reset')}</span>
									</button>
								</div>
							)}

							{(controlVariant === 'running' || controlVariant === 'paused') && (
								<div className="timer__grid timer__grid--primary">
									<button
										className="timer__button timer__button--ghost timer__button--block"
										onClick={handlePauseResume}
										disabled={!canControl}>
										<Icon path={isRunning ? mdiPause : mdiPlay} size={0.8} />
										{isRunning ? t('whiteboard', 'Pause') : t('whiteboard', 'Resume')}
									</button>
									<button
										className="timer__button timer__button--ghost timer__button--block"
										disabled={!canControl}
										onClick={() => handleExtend(1)}>
										<Icon path={mdiPlus} size={0.75} /> {t('whiteboard', 'Add 1 min')}
									</button>
									<button
										className="timer__button timer__button--ghost timer__button--block"
										disabled={!canControl}
										onClick={() => handleExtend(5)}>
										<Icon path={mdiPlus} size={0.75} /> {t('whiteboard', 'Add 5 min')}
									</button>
									<button
										className="timer__button timer__button--ghost timer__button--block"
										onClick={handleReset}
										disabled={!canControl}>
										<Icon path={mdiRestart} size={0.8} />
										<span className="timer__button-label">{t('whiteboard', 'Reset')}</span>
									</button>
								</div>
							)}
						</div>

						{(isPaused || isFinished) && (
							<div className="timer__hint">
								{isPaused
									? t('whiteboard', 'Resume to continue the shared timer.')
									: t('whiteboard', 'Start again to run a new timer.')}
							</div>
						)}

						{!timer.canControl && (
							<div className="timer__hint">
								{t('whiteboard', 'You can view the timer but only editors can change it.')}
							</div>
						)}

						{timer.error && (
							<div className="timer__error" onClick={timer.clearError}>
								{timer.error}
							</div>
						)}
					</div>
				</div>
			</DraggableDialog>
		</div>
	)
})
