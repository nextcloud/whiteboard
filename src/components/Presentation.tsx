/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { memo, useCallback, useEffect, useState } from 'react'
import { Icon } from '@mdi/react'
import {
	mdiPresentation,
	mdiPresentationPlay,
	mdiStop,
	mdiEye,
	mdiEyeOff,
	mdiAccount,
	mdiClose,
	mdiInformation,
} from '@mdi/js'
import { MainMenu } from '@nextcloud/excalidraw'
import { DraggableDialog } from './DraggableDialog'
import { t } from '@nextcloud/l10n'
import type { PresentationState } from '../types/presentation'

type PresentationStatusProps = Pick<
PresentationState,
	'isPresenting'
	| 'isPresentationMode'
	| 'presenterName'
	| 'presentationStartTime'
	| 'autoFollowPresenter'
	| 'status'
> & {
	onToggleAutoFollow: () => void
	onStopPresentation?: () => void
}

interface PresentationErrorProps {
	error: string
	onDismiss: () => void
}

type PresentationMenuItemProps = Pick<
PresentationState,
	'isPresenting'
	| 'isPresentationMode'
	| 'presenterName'
	| 'startPresentation'
	| 'stopPresentation'
	| 'isConnected'
> & {
	isStarting: boolean
	isStopping: boolean
}

// Error notification component
const PresentationError = memo(function PresentationError({ error, onDismiss }: PresentationErrorProps) {
	return (
		<div className="presentation-error">
			<div className="presentation-error__content">
				<Icon path={mdiInformation} size={1} />
				<span>{error}</span>
				<button onClick={onDismiss} className="presentation-error__close">
					<Icon path={mdiClose} size={0.8} />
				</button>
			</div>
		</div>
	)
})

// Status indicator component
const PresentationStatus = memo(function PresentationStatus({
	isPresenting,
	isPresentationMode,
	presenterName,
	presentationStartTime,
	autoFollowPresenter,
	status,
	onToggleAutoFollow,
	onStopPresentation,
}: PresentationStatusProps) {
	const [duration, setDuration] = useState<string>('00:00')

	// Update duration timer
	useEffect(() => {
		if (!presentationStartTime) return

		const updateDuration = () => {
			const elapsed = Date.now() - presentationStartTime
			const minutes = Math.floor(elapsed / 60000)
			const seconds = Math.floor((elapsed % 60000) / 1000)
			setDuration(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`)
		}

		updateDuration()
		const interval = setInterval(updateDuration, 1000)
		return () => clearInterval(interval)
	}, [presentationStartTime])

	if (isPresenting) {
		return (
			<div className="presentation-status presentation-status--presenting">
				<div className="presentation-status__content">
					<Icon path={mdiPresentationPlay} size={1} />
					<div className="presentation-status__info">
						<div className="presentation-status__title">
							You are presenting
							<span className="presentation-status__live-indicator">LIVE</span>
						</div>
						<div className="presentation-status__duration">{duration}</div>
					</div>
					{onStopPresentation && (
						<button
							onClick={onStopPresentation}
							className="presentation-status__stop-btn"
							disabled={status === 'stopping'}
							title={t('whiteboard', 'Stop presentation')}
						>
							<Icon path={mdiStop} size={0.9} />
							{status === 'stopping' ? t('whiteboard', 'Stopping…') : t('whiteboard', 'Stop')}
						</button>
					)}
				</div>
			</div>
		)
	}

	if (isPresentationMode && presenterName) {
		return (
			<div className="presentation-status presentation-status--watching">
				<div className="presentation-status__content">
					<Icon path={mdiAccount} size={1} />
					<div className="presentation-status__info">
						<div className="presentation-status__title">{presenterName} is presenting</div>
						<div className="presentation-status__duration">{duration}</div>
					</div>
					<button
						onClick={onToggleAutoFollow}
						className={`presentation-status__follow-btn ${autoFollowPresenter ? 'active' : ''}`}
						title={autoFollowPresenter ? t('whiteboard', 'Stop following presenter') : t('whiteboard', 'Follow presenter')}
					>
						<Icon path={autoFollowPresenter ? mdiEye : mdiEyeOff} size={0.9} />
						{autoFollowPresenter ? 'Following' : 'Follow'}
					</button>
				</div>
			</div>
		)
	}

	return null
})

// Main menu item component
export const PresentationMenuItem = memo(function PresentationMenuItem({
	isPresenting,
	isPresentationMode,
	presenterName,
	isStarting,
	isStopping,
	startPresentation,
	stopPresentation,
	isConnected,
}: PresentationMenuItemProps) {
	const isDisabled = isStarting || isStopping || (!isConnected && !isPresenting)

	const handleClick = useCallback(() => {
		if (isPresenting) {
			stopPresentation()
		} else {
			startPresentation()
		}
	}, [isPresenting, startPresentation, stopPresentation])

	// Show different states based on presentation mode
	let icon = mdiPresentation
	let text = t('whiteboard', 'Start Presentation')
	let className = 'presentation-button'
	let tooltip = t('whiteboard', 'Start presenting to share your viewport with others')

	if (isPresenting) {
		icon = mdiStop
		text = isStopping ? t('whiteboard', 'Stopping…') : t('whiteboard', 'Stop Presentation')
		className += ' presentation-button--presenting'
		tooltip = t('whiteboard', 'Stop presenting')
	} else if (isStarting) {
		icon = mdiPresentationPlay
		text = t('whiteboard', 'Starting…')
		className += ' presentation-button--starting'
		tooltip = t('whiteboard', 'Starting presentation….')
	} else if (isPresentationMode && presenterName) {
		icon = mdiPresentation
		text = t('whiteboard', '{presenterName} is presenting', { presenterName })
		className += ' presentation-button--watching'
		tooltip = t('whiteboard', '{presenterName} is currently presenting. Others will follow their viewport.', { presenterName })
	} else if (!isConnected) {
		className += ' presentation-button--disconnected'
		text = t('whiteboard', 'Start Presentation (Offline)')
		tooltip = t('whiteboard', 'Presentation requires connection to collaboration server')
	}

	return (
		<MainMenu.Item
			className={className}
			icon={<Icon path={icon} size={1} />}
			onSelect={handleClick}
			disabled={isDisabled}
			title={tooltip}
		>
			{text}
		</MainMenu.Item>
	)
})

// Main presentation overlay component
export const PresentationOverlay = memo(function PresentationOverlay({
	presentationState,
}: {
	presentationState: PresentationState
}) {
	const {
		isPresenting,
		isPresentationMode,
		presenterName,
		presentationStartTime,
		autoFollowPresenter,
		status,
		error,
		stopPresentation,
		toggleAutoFollow,
		resetError,
	} = presentationState

	// Show error if present
	if (error) {
		return (
			<div className="presentation-overlay">
				<DraggableDialog
					id="presentation-error"
					initialPosition={{ x: window.innerWidth - 420, y: 20 }}
					enableDrag={true}
				>
					<PresentationError error={error} onDismiss={resetError} />
				</DraggableDialog>
			</div>
		)
	}

	// Show status if presenting or watching
	if (isPresenting || isPresentationMode) {
		return (
			<div className="presentation-overlay">
				<DraggableDialog
					id="presentation-status"
					initialPosition={{ x: window.innerWidth - 420, y: 20 }}
					enableDrag={true}
				>
					<PresentationStatus
						isPresenting={isPresenting}
						isPresentationMode={isPresentationMode}
						presenterName={presenterName}
						presentationStartTime={presentationStartTime}
						autoFollowPresenter={autoFollowPresenter}
						status={status}
						onToggleAutoFollow={toggleAutoFollow}
						onStopPresentation={isPresenting ? stopPresentation : undefined}
					/>
				</DraggableDialog>
			</div>
		)
	}

	return null
})
