/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Icon } from '@mdi/react'
import { mdiSlashForwardBox, mdiRecordCircle, mdiStopCircle, mdiCheckCircle, mdiFolder, mdiClose } from '@mdi/js'
import { formatDuration } from '../hooks/useRecording'
import { MainMenu } from '@nextcloud/excalidraw'
import { memo, useCallback } from 'react'
import { DraggableDialog } from './DraggableDialog'
import { t } from '@nextcloud/l10n'
import type { RecordingMenuState, RecordingOverlayProps } from '../types/recording'

const RecordingError = memo(({ error, resetError }: { error: string, resetError: () => void }) => (
	<div className="recording-error" onClick={resetError}>
		<Icon path={mdiSlashForwardBox} size={0.8} />
		<span>{error}</span>
		<small>({t('whiteboard', 'Click to dismiss')})</small>
	</div>
))
RecordingError.displayName = 'RecordingError'

const RecordingStartingStatus = memo(({ startingPhase }: { startingPhase: 'preparing' | 'initializing' | null }) => (
	<div className="nc-notecard nc-notecard--info recording-starting-status">
		<div className="nc-notecard__icon">
			<div className="nc-loading-icon" />
		</div>
		<div className="nc-notecard__content">
			<div className="nc-notecard__text">
				<strong>{t('whiteboard', 'Starting recording…')}</strong>
				<div className="recording-starting-details">
					<div>
						{startingPhase === 'preparing' ? t('whiteboard', '• Preparing recording session…') : t('whiteboard', '✓ Recording session prepared')}
					</div>
					<div>
						{startingPhase === 'initializing' ? t('whiteboard', '• Initializing capture engine…') : startingPhase === 'preparing' ? t('whiteboard', '• Waiting for capture engine…') : t('whiteboard', '✓ Capture engine ready')}
					</div>
					<div>{t('whiteboard', '• This may take a few seconds')}</div>
				</div>
			</div>
		</div>
	</div>
))
RecordingStartingStatus.displayName = 'RecordingStartingStatus'

const RecordingStatus = memo(({ isStarting, isStopping, isRecording, duration, startingPhase, onStop }: {
	isStarting: boolean
	isStopping: boolean
	isRecording: boolean
	duration: number | null
	startingPhase: 'preparing' | 'initializing' | null
	onStop: () => void
}) => {
	if (isStarting) {
		return <RecordingStartingStatus startingPhase={startingPhase} />
	}

	if (isStopping) {
		return (
			<div className="recording-status stopping" role="status" aria-live="polite">
				<div className="recording-status__content">
					<span className="recording-status__spinner" aria-hidden="true" />
					<div className="recording-status__info">
						<div className="recording-status__title">{t('whiteboard', 'Stopping recording…')}</div>
					</div>
				</div>
			</div>
		)
	}

	if (isRecording && duration !== null) {
		return (
			<div className="recording-status recording" role="status" aria-live="polite">
				<div className="recording-status__content">
					<span className="recording-status__indicator" aria-hidden="true" />
					<div className="recording-status__info">
						<div className="recording-status__title">{t('whiteboard', 'Recording')}</div>
						<div className="recording-status__subtitle">{t('whiteboard', 'Duration')}: <span className="recording-status__duration">{formatDuration(duration)}</span></div>
					</div>
					<button
						type="button"
						className="recording-status__stop-button"
						onClick={onStop}
						title={t('whiteboard', 'Stop recording')}
						aria-label={t('whiteboard', 'Stop recording')}
					>
						<Icon path={mdiStopCircle} size={0.8} />
						<span>{t('whiteboard', 'Stop recording')}</span>
					</button>
				</div>
			</div>
		)
	}

	return null
})
RecordingStatus.displayName = 'RecordingStatus'

const OtherRecordingUsers = memo(({ users }: { users: RecordingOverlayProps['otherRecordingUsers'] }) => {
	const displayName = users[0]?.username?.trim() || t('whiteboard', 'Unknown user')
	const label = users.length === 1
		? displayName
		: t('whiteboard', '{count} users', { count: users.length })
	const title = users.length === 1
		? t('whiteboard', 'Other user recording')
		: t('whiteboard', 'Others recording')

	return (
		<div className="recording-status recording is-others" role="status" aria-live="polite">
			<div className="recording-status__content">
				<span className="recording-status__indicator" aria-hidden="true" />
				<div className="recording-status__info">
					<div className="recording-status__title">{title}</div>
					<div className="recording-status__subtitle">{label}</div>
				</div>
			</div>
		</div>
	)
})
OtherRecordingUsers.displayName = 'OtherRecordingUsers'

const RecordingUploadStatus = memo(({ onDismiss }: { onDismiss: () => void }) => (
	<div className="nc-notecard nc-notecard--info recording-upload-status">
		<div className="nc-notecard__icon">
			<div className="nc-loading-icon" />
		</div>
		<div className="nc-notecard__content">
			<div className="nc-notecard__text">
				{t('whiteboard', 'Uploading recording…')}
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title={t('whiteboard', 'Dismiss')}
			aria-label={t('whiteboard', 'Dismiss')}>
			<Icon path={mdiClose} size={0.8} />
		</button>
	</div>
))
RecordingUploadStatus.displayName = 'RecordingUploadStatus'

const RecordingSuccess = memo(({
	fileUrl,
	filename,
	recordingDuration,
	onDismiss,
}: {
	fileUrl: string
	filename: string | null
	recordingDuration: number | null
	onDismiss: () => void
}) => (
	<div className="nc-notecard nc-notecard--success recording-success">
		<div className="nc-notecard__icon">
			<Icon path={mdiCheckCircle} size={1} />
		</div>
		<div className="nc-notecard__content">
			<div className="nc-notecard__text">
				<strong>{t('whiteboard', 'Recording saved successfully!')}</strong>
				<div className="recording-details">
					{filename && <div>{t('whiteboard', 'File')}: {filename}</div>}
					{recordingDuration && (
						<div>{t('whiteboard', 'Duration')}: {formatDuration(recordingDuration)}</div>
					)}
					<div className="recording-location">
						<Icon path={mdiFolder} size={0.6} />
						<span>{t('whiteboard', 'Saved to "Whiteboard Recordings" folder')}</span>
					</div>
					<div className="recording-actions">
						<a href={fileUrl}
						   className="nc-button nc-button--primary nc-button--small"
						   target="_blank"
						   rel="noopener noreferrer">
							{t('whiteboard', 'View recording')}
						</a>
					</div>
				</div>
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title={t('whiteboard', 'Dismiss')}
			aria-label={t('whiteboard', 'Dismiss')}>
			<Icon path={mdiClose} size={0.8} />
		</button>
	</div>
))
RecordingSuccess.displayName = 'RecordingSuccess'

const RecordingUnavailable = memo(({ reason, onDismiss }: { reason: string; onDismiss: () => void }) => (
	<div className="nc-notecard nc-notecard--warning recording-unavailable">
		<div className="nc-notecard__icon">
			<Icon path={mdiSlashForwardBox} size={1} />
		</div>
		<div className="nc-notecard__content">
			<div className="nc-notecard__text">
				<strong>{t('whiteboard', 'Recording unavailable')}</strong>
				<div className="recording-details">
					<div>{reason}</div>
					<div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.8 }}>
						{t('whiteboard', 'Contact your administrator to enable recording functionality.')}
					</div>
				</div>
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title={t('whiteboard', 'Dismiss')}
			aria-label={t('whiteboard', 'Dismiss')}>
			<Icon path={mdiClose} size={0.8} />
		</button>
	</div>
))
RecordingUnavailable.displayName = 'RecordingUnavailable'

export const RecordingOverlay = memo(function RecordingOverlay(props: RecordingOverlayProps) {
	const {
		isStarting,
		isStopping,
		isRecording,
		hasError,
		error,
		duration,
		otherRecordingUsers,
		hasOtherRecordingUsers,
		fileUrl,
		showSuccess,
		isUploading,
		filename,
		recordingDuration,
		startingPhase,
		stopRecording,
		resetError,
		dismissSuccess,
		dismissUnavailableInfo,
		showUnavailableInfo,
		unavailableReason,
	} = props
	// Show unavailable info if recording is not available
	if (showUnavailableInfo && unavailableReason) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-unavailable"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<RecordingUnavailable reason={unavailableReason} onDismiss={dismissUnavailableInfo} />
				</DraggableDialog>
			</div>
		)
	}

	if (hasError && error) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-error"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={false}
				>
					<RecordingError error={error} resetError={resetError} />
				</DraggableDialog>
			</div>
		)
	}

	if (isStarting) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-starting"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<RecordingStartingStatus startingPhase={startingPhase} />
				</DraggableDialog>
			</div>
		)
	}

	if (isUploading) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-upload"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<RecordingUploadStatus onDismiss={dismissSuccess} />
				</DraggableDialog>
			</div>
		)
	}

	if (showSuccess && fileUrl) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-success"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<RecordingSuccess
						fileUrl={fileUrl}
						filename={filename}
						recordingDuration={recordingDuration}
						onDismiss={dismissSuccess}
					/>
				</DraggableDialog>
			</div>
		)
	}

	if (isRecording || isStopping) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-status"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<div>
						<RecordingStatus
							isStarting={isStarting}
							isStopping={isStopping}
							isRecording={isRecording}
							duration={duration}
							startingPhase={startingPhase}
							onStop={() => {
								stopRecording().catch((error) => {
									console.error('[Recording] Failed to stop recording from overlay:', error)
								})
							}}
						/>
						{hasOtherRecordingUsers && (
							<OtherRecordingUsers users={otherRecordingUsers} />
						)}
					</div>
				</DraggableDialog>
			</div>
		)
	}

	if (hasOtherRecordingUsers) {
		return (
			<div className="recording-overlay">
				<DraggableDialog
					id="recording-others"
					initialPosition={{ x: 20, y: 20 }}
					enableDrag={true}
				>
					<OtherRecordingUsers users={otherRecordingUsers} />
				</DraggableDialog>
			</div>
		)
	}

	return null
})

export const RecordingMenuItem = memo(function RecordingMenuItem({
	isRecording,
	isStarting,
	isStopping,
	startRecording,
	stopRecording,
	isConnected,
	isAvailable,
	unavailableReason,
}: RecordingMenuState) {
	// Determine disabled state and tooltip
	let isDisabled = isStarting || isStopping
	let tooltipMessage: string | undefined

	if (!isRecording) {
		if (!isConnected) {
			isDisabled = true
			tooltipMessage = t('whiteboard', 'Recording requires connection to collaboration server')
		} else if (isAvailable === false) {
			isDisabled = true
			tooltipMessage = unavailableReason || t('whiteboard', 'Recording is currently unavailable')
		} else if (isAvailable === null) {
			// Still checking availability
			isDisabled = true
			tooltipMessage = t('whiteboard', 'Checking recording availability…')
		}
	}

	const handleSelect = useCallback(() => {
		const action = isRecording ? stopRecording : startRecording
		action().catch((error) => {
			console.error('[Recording] Failed to toggle recording:', error)
		})
	}, [isRecording, startRecording, stopRecording])

	return (
		<MainMenu.Item
			className={`recording-button ${isRecording ? 'recording' : ''} ${!isConnected || isAvailable === false ? 'disconnected' : ''}`}
			icon={<Icon path={isRecording ? mdiStopCircle : mdiRecordCircle} size={1} />}
			onSelect={handleSelect}
			disabled={isDisabled}
			title={tooltipMessage}
		>
			{isRecording ? t('whiteboard', 'Stop Recording') : t('whiteboard', 'Start Recording')}
		</MainMenu.Item>
	)
})
