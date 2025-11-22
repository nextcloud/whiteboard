/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { Icon } from '@mdi/react'
import {
	mdiTimerOutline,
	mdiPause,
	mdiPlay,
	mdiRestart,
	mdiPlus,
	mdiChevronUp,
	mdiChevronDown,
} from '@mdi/js'
import { DraggableDialog } from './DraggableDialog'
import type { UseTimerResult } from '../hooks/useTimer'
import { t } from '@nextcloud/l10n'
import './Timer.scss'

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

interface TimerOverlayProps {
	timer: UseTimerResult
}

export const TimerOverlay = memo(function TimerOverlay({ timer }: TimerOverlayProps) {
	const [minutesInput, setMinutesInput] = useState(5)
	const [isCollapsed, setIsCollapsed] = useState(true)

	useEffect(() => {
		if (timer.durationMs) {
			setMinutesInput(Math.max(1, Math.round(timer.durationMs / 60000)))
		}
	}, [timer.durationMs])

	const formattedTime = useMemo(() => formatCountdown(timer.displayRemainingMs), [timer.displayRemainingMs])
	const isRunning = timer.status === 'running'
	const isPaused = timer.status === 'paused'
	const isFinished = timer.status === 'finished'
	const isIdle = timer.status === 'idle'
	const clampMinutes = (value: number) => Math.min(Math.max(value, 1), 240)

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

	const canControl = timer.canControl && timer.isConnected
	const disableStart = !canControl
	const disablePause = !canControl || (!isRunning && !isPaused)
	const disableExtend = !canControl || (!isRunning && !isPaused)

	const handleStart = () => timer.startTimer(clampMinutes(minutesInput) * 60 * 1000)
	const handlePauseResume = () => {
		if (isRunning) {
			timer.pauseTimer()
		} else {
			timer.resumeTimer()
		}
	}
	const handleReset = () => timer.resetTimer()
	const handleExtend = (minutes: number) => timer.extendTimer(minutes * 60 * 1000)

	const initialPosition = useMemo(() => ({
		x: typeof window !== 'undefined' ? Math.max(window.innerWidth - 420, 20) : 20,
		y: 90,
	}), [])

	const renderCollapsed = () => {
		const primaryLabel = isRunning
			? t('whiteboard', 'Pause')
			: isPaused
				? t('whiteboard', 'Resume')
				: t('whiteboard', 'Start')

		const primaryIcon = isRunning ? mdiPause : mdiPlay

		return (
			<div className="timer timer--compact">
				<div className="timer__header">
					<div className="timer__title">
						<Icon path={mdiTimerOutline} size={1} />
						<span>{t('whiteboard', 'Timer')}</span>
					</div>
					<div className={`timer__status timer__status--${timer.status}`}>
						<span className="timer__status-dot" />
						<span className="timer__status-text">{statusLabel}</span>
					</div>
					<div className="timer__header-actions">
						<button
							className="timer__collapse"
							onClick={() => setIsCollapsed(false)}
							title={t('whiteboard', 'Expand timer panel')}
							aria-label={t('whiteboard', 'Expand timer panel')}>
							<Icon path={mdiChevronDown} size={0.85} />
						</button>
					</div>
				</div>

				<div className="timer__display timer__display--compact">
					<div className={`timer__time ${isFinished ? 'timer__time--finished' : ''}`}>
						{formattedTime}
					</div>
					<button
						className="timer__button"
						onClick={handlePauseResume}
						disabled={!canControl}>
						<Icon path={primaryIcon} size={0.8} />
						{primaryLabel}
					</button>
				</div>
			</div>
		)
	}

	if (isCollapsed) {
		return (
			<div className="timer-overlay">
				<DraggableDialog
					id="whiteboard-timer"
					initialPosition={initialPosition}
					enableDrag={true}>
					{renderCollapsed()}
				</DraggableDialog>
			</div>
		)
	}

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
							<span className="timer__status-dot" />
							<span className="timer__status-text">{statusLabel}</span>
							{startedByLabel && (
								<small className="timer__status-sub">{startedByLabel}</small>
							)}
						</div>
						<div className="timer__header-actions">
							<button
								className="timer__collapse"
								onClick={() => setIsCollapsed(true)}
								title={t('whiteboard', 'Collapse timer panel')}
								aria-label={t('whiteboard', 'Collapse timer panel')}>
								<Icon path={mdiChevronUp} size={0.85} />
							</button>
						</div>
					</div>

					<div className="timer__display">
						<div className={`timer__time ${isFinished ? 'timer__time--finished' : ''}`}>
							{formattedTime}
						</div>
						{!timer.isConnected && (
							<div className="timer__offline">{t('whiteboard', 'Waiting for connection…')}</div>
						)}
					</div>

					<div className="timer__controls">
						<div className="timer__inputs">
							<label className="timer__label" htmlFor="timer-minutes">
								{t('whiteboard', 'Minutes')}
							</label>
							<div className="timer__input-row">
								<input
									id="timer-minutes"
									type="number"
									min={1}
									max={240}
									value={minutesInput}
									onChange={(event) => setMinutesInput(clampMinutes(Number(event.target.value) || 1))}
									disabled={!timer.canControl}
								/>
								<button
									className="timer__button timer__button--start"
									onClick={handleStart}
									disabled={disableStart}>
									<Icon path={mdiPlay} size={0.8} />
									{isRunning ? t('whiteboard', 'Restart') : t('whiteboard', 'Start')}
								</button>
							</div>
							<div className="timer__presets">
								{[1, 5, 10, 15].map((minutes) => (
									<button
										key={minutes}
										className="timer__chip"
										disabled={!timer.canControl}
										onClick={() => {
											setMinutesInput(minutes)
											timer.startTimer(minutes * 60 * 1000)
										}}>
										{`${minutes} ${t('whiteboard', 'min')}`}
									</button>
								))}
							</div>
						</div>

						<div className="timer__action-row">
							<button
								className="timer__button"
								onClick={handlePauseResume}
								disabled={disablePause}>
								<Icon path={isRunning ? mdiPause : mdiPlay} size={0.8} />
								{isRunning ? t('whiteboard', 'Pause') : t('whiteboard', 'Resume')}
							</button>
							<button
								className="timer__button"
								onClick={handleReset}
								disabled={!canControl}>
								<Icon path={mdiRestart} size={0.8} />
								{t('whiteboard', 'Reset')}
							</button>
						</div>

						<div className="timer__extend">
							<span>{t('whiteboard', 'Add time')}</span>
							<div className="timer__extend-buttons">
								<button
									className="timer__button"
									disabled={disableExtend}
									onClick={() => handleExtend(1)}>
									<Icon path={mdiPlus} size={0.75} /> {t('whiteboard', 'Add 1 min')}
								</button>
								<button
									className="timer__button"
									disabled={disableExtend}
									onClick={() => handleExtend(5)}>
									<Icon path={mdiPlus} size={0.75} /> {t('whiteboard', 'Add 5 min')}
								</button>
							</div>
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
