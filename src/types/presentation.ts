/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PresentationStatus = 'idle' | 'starting' | 'presenting' | 'stopping'

export interface PresentationState {
	// Current state
	isPresenting: boolean
	isPresentationMode: boolean
	presenterId: string | null
	presenterName: string | null
	presentationStartTime: number | null
	autoFollowPresenter: boolean

	// Status indicators
	status: PresentationStatus
	error: string | null
	isConnected: boolean

	// Actions
	startPresentation: () => Promise<void>
	stopPresentation: () => Promise<void>
	toggleAutoFollow: () => void
	resetError: () => void
}
