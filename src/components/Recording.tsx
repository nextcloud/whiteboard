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
		<Icon path={mdiRecordCircle} size={0.8} />
		<span>Recording saved successfully!</span>
		<a href={fileUrl} target="_blank" rel="noopener noreferrer">View Recording</a>
		<small onClick={onDismiss}>(Click to dismiss)</small>
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
	const renderRecordingError = useCallback(() => {
		if (!hasError || !error) return null
		return <RecordingError error={error} resetError={resetError} />
	}, [hasError, error, resetError])

	const renderRecordingStatus = useCallback(() => {
		if (hasError) return null
		return (
			<RecordingStatus
				isStarting={isStarting}
				isStopping={isStopping}
				isRecording={isRecording}
				duration={duration}
			/>
		)
	}, [hasError, isStarting, isStopping, isRecording, duration])

	const renderOtherRecordingUsers = useCallback(() => {
		if (!hasOtherRecordingUsers) return null
		return <OtherRecordingUsers users={otherRecordingUsers} />
	}, [hasOtherRecordingUsers, otherRecordingUsers])

	const renderRecordingSuccess = useCallback(() => {
		if (!showSuccess || !fileUrl) return null
		return <RecordingSuccess fileUrl={fileUrl} onDismiss={dismissSuccess} />
	}, [showSuccess, fileUrl, dismissSuccess])

	const renderRecordingOverlay = useCallback(() => {
		if (!isStarting && !isStopping && !isRecording && !hasError && !hasOtherRecordingUsers && !showSuccess) {
			return null
		}

		return (
			<div className="recording-overlay">
				{(isStarting || isStopping || isRecording) && renderRecordingStatus()}
				{hasError && renderRecordingError()}
				{showSuccess && renderRecordingSuccess()}
				{hasOtherRecordingUsers && renderOtherRecordingUsers()}
			</div>
		)
	}, [
		isStarting,
		isStopping,
		isRecording,
		hasError,
		hasOtherRecordingUsers,
		showSuccess,
		renderRecordingStatus,
		renderRecordingError,
		renderRecordingSuccess,
		renderOtherRecordingUsers,
	])

	const renderRecordingMenuItem = useCallback(() => {
		return (
			<>
				<MainMenu.Item
					className={`recording-button ${isRecording ? 'recording' : ''}`}
					icon={<Icon path={isRecording ? mdiStopCircle : mdiRecordCircle} size={1} />}
					onSelect={() => isRecording ? stopRecording() : startRecording()}
					shortcut="⌘+⇧+R"
					disabled={isStarting || isStopping}>
					{isRecording ? 'Stop Recording' : 'Start Recording'}
				</MainMenu.Item>
			</>
		)
	}, [isRecording, isStarting, isStopping, startRecording, stopRecording])

	return {
		renderRecordingOverlay,
		renderRecordingMenuItem,
	}
}
