/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import type { CollaborationSocket } from '../types/collaboration'
import type { Voting } from '../types/voting'

export type CollaborationConnectionStatus = 'online' | 'offline' | 'connecting' | 'reconnecting'

export type AuthErrorType = 'jwt_secret_mismatch' | 'token_expired' | 'unauthorized' | null

interface AuthErrorState {
	type: AuthErrorType
	message: string | null
	consecutiveFailures: number
	lastFailureTime: number | null
	isPersistent: boolean
}

interface CollaborationStore {
	status: CollaborationConnectionStatus
	socket: CollaborationSocket | null
	isDedicatedSyncer: boolean
	authError: AuthErrorState
	followedUserId: string | null
	isInRoom: boolean
	lastSceneHash: number | null
	broadcastedElementVersions: Record<string, number>

	presenterId: string | null
	isPresentationMode: boolean
	isPresenting: boolean
	presentationStartTime: number | null
	autoFollowPresenter: boolean

	votings: Voting[]

	setStatus: (status: CollaborationConnectionStatus) => void
	setSocket: (socket: CollaborationSocket | null) => void
	setDedicatedSyncer: (isSyncer: boolean) => void
	setIsInRoom: (inRoom: boolean) => void
	setLastSceneHash: (hash: number | null) => void
	replaceBroadcastedElementVersions: (versions: Record<string, number>) => void
	mergeBroadcastedElementVersions: (versions: Record<string, number>) => void
	resetSceneSyncState: () => void
	setAuthError: (error: Partial<AuthErrorState>) => void
	incrementAuthFailure: (errorType: AuthErrorType, message: string) => void
	clearAuthError: () => void
	resetStore: () => void

	setPresentationState: (state: {
		presenterId?: string | null
		isPresentationMode?: boolean
		isPresenting?: boolean
		presentationStartTime?: number | null
	}) => void
	setAutoFollowPresenter: (autoFollow: boolean) => void

	addVoting: (voting: Voting) => void
	updateVoting: (voting: Voting) => void
	setVotings: (votings: Voting[]) => void
}

const initialAuthErrorState: AuthErrorState = {
	type: null,
	message: null,
	consecutiveFailures: 0,
	lastFailureTime: null,
	isPersistent: false,
}

const initialState: Omit<
CollaborationStore,
| 'setStatus'
| 'setSocket'
| 'setDedicatedSyncer'
| 'setIsInRoom'
| 'setLastSceneHash'
| 'replaceBroadcastedElementVersions'
| 'mergeBroadcastedElementVersions'
| 'resetSceneSyncState'
| 'setAuthError'
| 'incrementAuthFailure'
| 'clearAuthError'
| 'resetStore'
| 'setPresentationState'
| 'setAutoFollowPresenter'
| 'addVoting'
| 'updateVoting'
| 'setVotings'
> = {
	status: 'offline',
	socket: null,
	isDedicatedSyncer: false,
	authError: initialAuthErrorState,
	followedUserId: null,
	isInRoom: false,
	lastSceneHash: null,
	broadcastedElementVersions: {},

	presenterId: null,
	isPresentationMode: false,
	isPresenting: false,
	presentationStartTime: null,
	autoFollowPresenter: true,

	votings: [],
}

const MAX_AUTH_FAILURES = 3
const PERSISTENT_FAILURE_THRESHOLD = 5 * 60 * 1000

export const useCollaborationStore = create<CollaborationStore>()((set) => ({
	...initialState,

	setStatus: (status) => set((state) => (state.status === status ? {} : { status })),
	setSocket: (socket) => set({ socket }),
	setDedicatedSyncer: (isSyncer) => set({ isDedicatedSyncer: isSyncer }),
	setIsInRoom: (inRoom) => set({ isInRoom: inRoom }),
	setLastSceneHash: (hash) => set({ lastSceneHash: hash }),
	replaceBroadcastedElementVersions: (versions) => set({ broadcastedElementVersions: versions }),
	mergeBroadcastedElementVersions: (versions) => set((state) => ({
		broadcastedElementVersions: Object.entries(versions).reduce<Record<string, number>>((nextVersions, [id, version]) => {
			nextVersions[id] = nextVersions[id] === undefined
				? version
				: Math.max(nextVersions[id], version)
			return nextVersions
		}, { ...state.broadcastedElementVersions }),
	})),
	resetSceneSyncState: () => set({
		lastSceneHash: null,
		broadcastedElementVersions: {},
	}),

	setAuthError: (error) => set((state) => ({
		authError: { ...state.authError, ...error },
	})),

	incrementAuthFailure: (errorType, message) => set((state) => {
		const now = Date.now()
		const newFailureCount = state.authError.consecutiveFailures + 1
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

	setPresentationState: (state) => set((currentState) => ({
		...currentState,
		...state,
	})),

	setAutoFollowPresenter: (autoFollow) => set({ autoFollowPresenter: autoFollow }),

	addVoting: (voting) => set((state) => ({
		votings: [...state.votings, voting],
	})),

	updateVoting: (voting) => set((state) => ({
		votings: state.votings.map(v => v.uuid === voting.uuid ? voting : v),
	})),

	setVotings: (votings) => set({ votings }),
}))

type WhiteboardTestHooks = {
	collaborationStore?: typeof useCollaborationStore
}

declare global {
	interface Window {
		__whiteboardTest?: boolean
		__whiteboardTestHooks?: WhiteboardTestHooks & Record<string, unknown>
	}
}

const attachTestHooks = () => {
	if (typeof window === 'undefined' || !window.__whiteboardTest) {
		return
	}

	window.__whiteboardTestHooks = window.__whiteboardTestHooks || {}
	window.__whiteboardTestHooks.collaborationStore = useCollaborationStore
}

attachTestHooks()
