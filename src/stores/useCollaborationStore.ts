/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import type { Socket } from 'socket.io-client'

export type CollaborationConnectionStatus = 'online' | 'offline' | 'connecting' | 'reconnecting'

export type AuthErrorType = 'jwt_secret_mismatch' | 'token_expired' | 'unauthorized' | null

interface AuthErrorState {
	type: AuthErrorType
	message: string | null
	consecutiveFailures: number
	lastFailureTime: number | null
	isPersistent: boolean // True when we've detected a persistent auth issue (likely JWT secret mismatch)
}

interface CollaborationStore {
	status: CollaborationConnectionStatus
	socket: Socket | null
	isDedicatedSyncer: boolean // Is this client responsible for syncing to server/broadcasting?
	authError: AuthErrorState
	followedUserId: string | null // User ID being followed for viewport synchronization

	// Presentation state
	presenterId: string | null // User ID of current presenter
	isPresentationMode: boolean // Whether presentation mode is active in the room
	isPresenting: boolean // Whether current user is presenting
	presentationStartTime: number | null // When presentation started
	autoFollowPresenter: boolean // Whether to automatically follow presenter (can be disabled by user)

	// Actions
	setStatus: (status: CollaborationConnectionStatus) => void
	setSocket: (socket: Socket | null) => void
	setDedicatedSyncer: (isSyncer: boolean) => void
	setAuthError: (error: Partial<AuthErrorState>) => void
	incrementAuthFailure: (errorType: AuthErrorType, message: string) => void
	clearAuthError: () => void
	resetStore: () => void

	// Presentation actions
	setPresentationState: (state: {
		presenterId?: string | null
		isPresentationMode?: boolean
		isPresenting?: boolean
		presentationStartTime?: number | null
	}) => void
	setAutoFollowPresenter: (autoFollow: boolean) => void
}

const initialAuthErrorState: AuthErrorState = {
	type: null,
	message: null,
	consecutiveFailures: 0,
	lastFailureTime: null,
	isPersistent: false,
}

const initialState: Omit<CollaborationStore, 'setStatus' | 'setSocket' | 'setDedicatedSyncer' | 'setAuthError' | 'incrementAuthFailure' | 'clearAuthError' | 'resetStore' | 'setPresentationState' | 'setAutoFollowPresenter'> = {
	status: 'offline',
	socket: null,
	isDedicatedSyncer: false,
	authError: initialAuthErrorState,
	followedUserId: null,

	// Presentation initial state
	presenterId: null,
	isPresentationMode: false,
	isPresenting: false,
	presentationStartTime: null,
	autoFollowPresenter: true,
}

// Constants for auth failure detection
const MAX_AUTH_FAILURES = 3
const PERSISTENT_FAILURE_THRESHOLD = 5 * 60 * 1000 // 5 minutes

export const useCollaborationStore = create<CollaborationStore>()((set) => ({
	...initialState,

	setStatus: (status) => set((state) => (state.status === status ? {} : { status })),
	setSocket: (socket) => set({ socket }),
	setDedicatedSyncer: (isSyncer) => set({ isDedicatedSyncer: isSyncer }),

	setAuthError: (error) => set((state) => ({
		authError: { ...state.authError, ...error },
	})),

	incrementAuthFailure: (errorType, message) => set((state) => {
		const now = Date.now()
		const newFailureCount = state.authError.consecutiveFailures + 1

		// Determine if this is a persistent issue (likely JWT secret mismatch)
		const isPersistent = newFailureCount >= MAX_AUTH_FAILURES
			&& (state.authError.lastFailureTime === null
			 || now - state.authError.lastFailureTime < PERSISTENT_FAILURE_THRESHOLD)

		return {
			authError: {
				type: errorType,
				message,
				consecutiveFailures: newFailureCount,
				lastFailureTime: now,
				isPersistent,
			},
		}
	}),

	clearAuthError: () => set({ authError: initialAuthErrorState }),

	resetStore: () => set(initialState),

	// Presentation actions
	setPresentationState: (state) => set((currentState) => ({
		...currentState,
		...state,
	})),

	setAutoFollowPresenter: (autoFollow) => set({ autoFollowPresenter: autoFollow }),
}))
