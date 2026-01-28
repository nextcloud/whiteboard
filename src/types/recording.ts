/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping'

export interface RecordingUser {
	userId: string
	username: string
}

export interface RecordingState {
	isRecording: boolean
	error: string | null
	startTime: number | null
	status: RecordingStatus
	duration: number | null
	otherUsers: RecordingUser[]
	fileUrl: string | null
	showSuccess: boolean
	isUploading: boolean
	filename: string | null
	recordingDuration: number | null
	successTimestamp: number | null
	startingPhase: 'preparing' | 'initializing' | null
	isAvailable: boolean | null
	unavailableReason: string | null
	showUnavailableInfo: boolean
	autoUploadOnDisconnect: boolean
}

export interface RecordingActions {
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	resetError: () => void
	dismissSuccess: () => void
	dismissUnavailableInfo: () => void
}

export interface RecordingComputedState {
	hasError: boolean
	isStarting: boolean
	isStopping: boolean
	hasOtherRecordingUsers: boolean
	isConnected: boolean
}

export type RecordingHookState = RecordingState & RecordingActions & RecordingComputedState

export interface RecordingOverlayProps {
	isStarting: boolean
	isStopping: boolean
	isRecording: boolean
	hasError: boolean
	error: string | null
	duration: number | null
	otherRecordingUsers: RecordingUser[]
	hasOtherRecordingUsers: boolean
	fileUrl: string | null
	showSuccess: boolean
	isUploading: boolean
	filename: string | null
	recordingDuration: number | null
	startingPhase: 'preparing' | 'initializing' | null
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	resetError: () => void
	dismissSuccess: () => void
	dismissUnavailableInfo: () => void
	isConnected: boolean
	isAvailable: boolean | null
	unavailableReason: string | null
	showUnavailableInfo: boolean
}

export interface RecordingMenuState {
	isRecording: boolean
	isStarting: boolean
	isStopping: boolean
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	isConnected: boolean
	isAvailable: boolean | null
	unavailableReason: string | null
}
