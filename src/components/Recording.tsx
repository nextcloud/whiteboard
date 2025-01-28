/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Icon } from '@mdi/react'
import { mdiSlashForwardBox, mdiRecordCircle, mdiStopCircle } from '@mdi/js'
import { formatDuration } from '../hooks/useRecording'
import { MainMenu } from '@excalidraw/excalidraw'
import { memo, useCallback } from 'react'

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
	startRecording: () => void
	stopRecording: () => void
	resetError: () => void
	dismissSuccess: () => void
}

interface RecordingUIComponents {
	renderRecordingOverlay: () => JSX.Element | null
	renderRecordingMenuItem: () => JSX.Element
}

const RecordingError = memo(({ error, resetError }: { error: string, resetError: () => void }) => (
	<div className="recording-error" onClick={resetError}>
		<Icon path={mdiSlashForwardBox} size={0.8} />
		<span>{error}</span>
		<small>(Click to dismiss)</small>
	</div>
))
RecordingError.displayName = 'RecordingError'

const RecordingStatus = memo(({ isStarting, isStopping, isRecording, duration }: {
	isStarting: boolean
	isStopping: boolean
	isRecording: boolean
	duration: number | null
}) => {
	if (isStarting || isStopping) {
		return (
			<div className="recording-status">
				<div className="recording-spinner" />
				<span>{isStarting ? 'Starting recording...' : 'Stopping recording...'}</span>
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

const RecordingSuccess = memo(({ fileUrl, onDismiss }: { fileUrl: string, onDismiss: () => void }) => (
	<div className="recording-success">
		<div className="recording-success-content">
			<span>Recording saved successfully!</span>
			<a href={fileUrl}
			   className="recording-success-link"
			   target="_blank"
			   rel="noopener noreferrer">
				View recording
			</a>
			<button
				className="recording-success-dismiss"
				onClick={onDismiss}
				title="Dismiss">
				×
			</button>
		</div>
	</div>
))
RecordingSuccess.displayName = 'RecordingSuccess'

export function Recording({
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
	startRecording,
	stopRecording,
	resetError,
	dismissSuccess,
}: RecordingProps): RecordingUIComponents {
	const renderRecordingOverlay = useCallback(() => {
		if (hasError && error) {
			return <RecordingError error={error} resetError={resetError} />
		}

		if (showSuccess && fileUrl) {
			return <RecordingSuccess fileUrl={fileUrl} onDismiss={dismissSuccess} />
		}

		if (isRecording) {
			return (
				<div className="recording-overlay">
					<RecordingStatus
						isStarting={isStarting}
						isStopping={isStopping}
						isRecording={isRecording}
						duration={duration}
					/>
					{hasOtherRecordingUsers && (
						<OtherRecordingUsers users={otherRecordingUsers} />
					)}
				</div>
			)
		}

		return null
	}, [
		hasError, error, resetError,
		showSuccess, fileUrl, dismissSuccess,
		isRecording, isStarting, isStopping,
		duration, hasOtherRecordingUsers, otherRecordingUsers,
	])

	const renderRecordingMenuItem = useCallback(() => (
		<MainMenu.Item
			className={`recording-button ${isRecording ? 'recording' : ''}`}
			icon={<Icon path={isRecording ? mdiStopCircle : mdiRecordCircle} size={1} />}
			onSelect={isRecording ? stopRecording : startRecording}
			shortcut="⌘+⇧+R"
			disabled={isStarting || isStopping}
		>
			{isRecording ? 'Stop Recording' : 'Start Recording'}
		</MainMenu.Item>
	), [isRecording, isStarting, isStopping, startRecording, stopRecording])

	return { renderRecordingOverlay, renderRecordingMenuItem }
}
