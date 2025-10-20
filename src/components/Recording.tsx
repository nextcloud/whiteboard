/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Icon } from '@mdi/react'
import { mdiSlashForwardBox, mdiRecordCircle, mdiStopCircle, mdiCheckCircle, mdiFolder, mdiClose } from '@mdi/js'
import { formatDuration } from '../hooks/useRecording'
import { MainMenu } from '@nextcloud/excalidraw'
import { memo } from 'react'
import { DraggableDialog } from './DraggableDialog'

interface RecordingProps {
	isStarting: boolean
	isStopping: boolean
	isRecording: boolean
	hasError: boolean
	error: string | null
	duration: number | null
	otherRecordingUsers: Array<{ userId: string; username: string }>
	hasOtherRecordingUsers: boolean
	fileUrl: string | null
	showSuccess: boolean
	isUploading: boolean
	filename: string | null
	recordingDuration: number | null
	startingPhase: 'preparing' | 'initializing' | null
	startRecording: () => void
	stopRecording: () => void
	resetError: () => void
	dismissSuccess: () => void
	dismissUnavailableInfo: () => void
	isConnected: boolean
	isAvailable: boolean | null
	unavailableReason: string | null
	showUnavailableInfo: boolean
}

const RecordingError = memo(({ error, resetError }: { error: string, resetError: () => void }) => (
	<div className="recording-error" onClick={resetError}>
		<Icon path={mdiSlashForwardBox} size={0.8} />
		<span>{error}</span>
		<small>(Click to dismiss)</small>
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
				<strong>Starting recording...</strong>
				<div className="recording-starting-details">
					<div>
						{startingPhase === 'preparing' ? '• Preparing recording session...' : '✓ Recording session prepared'}
					</div>
					<div>
						{startingPhase === 'initializing' ? '• Initializing capture engine...' : startingPhase === 'preparing' ? '• Waiting for capture engine...' : '✓ Capture engine ready'}
					</div>
					<div>• This may take a few seconds</div>
				</div>
			</div>
		</div>
	</div>
))
RecordingStartingStatus.displayName = 'RecordingStartingStatus'

const RecordingStatus = memo(({ isStarting, isStopping, isRecording, duration, startingPhase }: {
	isStarting: boolean
	isStopping: boolean
	isRecording: boolean
	duration: number | null
	startingPhase: 'preparing' | 'initializing' | null
}) => {
	if (isStarting) {
		return <RecordingStartingStatus startingPhase={startingPhase} />
	}

	if (isStopping) {
		return (
			<div className="recording-status">
				<div className="recording-spinner" />
				<span>Stopping recording...</span>
			</div>
		)
	}

	if (isRecording && duration) {
		return (
			<div className="recording-status recording">
				<div className="recording-indicator" />
				<span>Recording: {formatDuration(duration)}</span>
			</div>
		)
	}

	return null
})
RecordingStatus.displayName = 'RecordingStatus'

const OtherRecordingUsers = memo(({ users }: { users: RecordingProps['otherRecordingUsers'] }) => (
	<div className="other-recording-users">
		<Icon path={mdiRecordCircle} size={0.8} />
		<span>
			{users.length === 1
				? `${users[0].username} is recording`
				: `${users.length} users are recording`}
		</span>
	</div>
))
OtherRecordingUsers.displayName = 'OtherRecordingUsers'

const RecordingUploadStatus = memo(({ onDismiss }: { onDismiss: () => void }) => (
	<div className="nc-notecard nc-notecard--info recording-upload-status">
		<div className="nc-notecard__icon">
			<div className="nc-loading-icon" />
		</div>
		<div className="nc-notecard__content">
			<div className="nc-notecard__text">
				Uploading recording...
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title="Dismiss"
			aria-label="Dismiss">
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
				<strong>Recording saved successfully!</strong>
				<div className="recording-details">
					{filename && <div>File: {filename}</div>}
					{recordingDuration && (
						<div>Duration: {formatDuration(recordingDuration)}</div>
					)}
					<div className="recording-location">
						<Icon path={mdiFolder} size={0.6} />
						<span>Saved to "Whiteboard Recordings" folder</span>
					</div>
					<div className="recording-actions">
						<a href={fileUrl}
						   className="nc-button nc-button--primary nc-button--small"
						   target="_blank"
						   rel="noopener noreferrer">
							View recording
						</a>
					</div>
				</div>
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title="Dismiss"
			aria-label="Dismiss">
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
				<strong>Recording unavailable</strong>
				<div className="recording-details">
					<div>{reason}</div>
					<div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.8 }}>
						Contact your administrator to enable recording functionality.
					</div>
				</div>
			</div>
		</div>
		<button
			className="nc-notecard__dismiss"
			onClick={onDismiss}
			title="Dismiss"
			aria-label="Dismiss">
			<Icon path={mdiClose} size={0.8} />
		</button>
	</div>
))
RecordingUnavailable.displayName = 'RecordingUnavailable'

export const RecordingOverlay = memo(function RecordingOverlay({
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
	resetError,
	dismissSuccess,
	dismissUnavailableInfo,
	showUnavailableInfo,
	unavailableReason,
}: RecordingProps) {
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
						/>
						{hasOtherRecordingUsers && (
							<OtherRecordingUsers users={otherRecordingUsers} />
						)}
					</div>
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
}: Pick<RecordingProps, 'isRecording' | 'isStarting' | 'isStopping' | 'startRecording' | 'stopRecording' | 'isAvailable' | 'unavailableReason'> & {
	isConnected: boolean
}) {
	// Determine disabled state and tooltip
	let isDisabled = isStarting || isStopping
	let tooltipMessage: string | undefined

	if (!isRecording) {
		if (!isConnected) {
			isDisabled = true
			tooltipMessage = 'Recording requires connection to collaboration server'
		} else if (isAvailable === false) {
			isDisabled = true
			tooltipMessage = unavailableReason || 'Recording is currently unavailable'
		} else if (isAvailable === null) {
			// Still checking availability
			isDisabled = true
			tooltipMessage = 'Checking recording availability...'
		}
	}

	return (
		<MainMenu.Item
			className={`recording-button ${isRecording ? 'recording' : ''} ${!isConnected || isAvailable === false ? 'disconnected' : ''}`}
			icon={<Icon path={isRecording ? mdiStopCircle : mdiRecordCircle} size={1} />}
			onSelect={isRecording ? stopRecording : startRecording}
			disabled={isDisabled}
			title={tooltipMessage}
		>
			{isRecording ? 'Stop Recording' : 'Start Recording'}
		</MainMenu.Item>
	)
})
