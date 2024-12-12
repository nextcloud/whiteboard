/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import type { RecordingState } from '../hooks/useWhiteboardRecording'
import { translate as t } from '@nextcloud/l10n'

interface RecordingControlsProps {
  recordingState: RecordingState
  onStartRecording: () => void
  onStopRecording: () => void
  onDownloadRecording: () => void
}

export function RecordingControls({
	recordingState,
	onStartRecording,
	onStopRecording,
	onDownloadRecording,
}: RecordingControlsProps) {
	const formatDuration = useCallback((seconds: number) => {
		const minutes = Math.floor(seconds / 60)
		const remainingSeconds = seconds % 60
		return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
	}, [])

	return (
		<div className="whiteboard-recording-controls">
			{!recordingState.isRecording
				? (
					<button
						className="recording-button start"
						onClick={onStartRecording}
						title={t('whiteboard', 'Start recording')}>
						<span className="recording-icon">⏺</span>
						{t('whiteboard', 'Record')}
					</button>
				)
				: (
					<>
						<button
							className="recording-button stop"
							onClick={onStopRecording}
							title={t('whiteboard', 'Stop recording')}>
							<span className="recording-icon">⏹</span>
							{formatDuration(recordingState.duration)}
						</button>
					</>
				)}
			{!recordingState.isRecording && recordingState.frames.length > 0 && (
				<button
					className="recording-button download"
					onClick={onDownloadRecording}
					title={t('whiteboard', 'Download recording')}>
					<span className="recording-icon">⬇</span>
					{t('whiteboard', 'Download')}
				</button>
			)}
		</div>
	)
}
