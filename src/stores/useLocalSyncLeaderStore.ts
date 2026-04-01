/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'

export type LocalSyncLeaderSnapshot = {
	isLocalLeader: boolean
	isPassiveFollower: boolean
	leaderTabId: string | null
	leaderHeartbeatAt: number | null
}

interface LocalSyncLeaderState extends LocalSyncLeaderSnapshot {
	tabId: string
	leaseKey: string | null
	userId: string | null
	setScope: (scope: { leaseKey: string | null; userId: string | null }) => void
	setLeadershipSnapshot: (snapshot: LocalSyncLeaderSnapshot) => void
	resetLeadership: () => void
	resetStore: () => void
}

let stableTabId: string | null = null

export const getStableLocalSyncTabId = () => {
	if (!stableTabId) {
		stableTabId = globalThis.crypto?.randomUUID?.()
			?? `local-sync-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
	}

	return stableTabId
}

const initialLeadershipSnapshot: LocalSyncLeaderSnapshot = {
	isLocalLeader: false,
	isPassiveFollower: false,
	leaderTabId: null,
	leaderHeartbeatAt: null,
}

export const useLocalSyncLeaderStore = create<LocalSyncLeaderState>()((set) => ({
	tabId: getStableLocalSyncTabId(),
	leaseKey: null,
	userId: null,
	...initialLeadershipSnapshot,

	setScope: ({ leaseKey, userId }) => set({ leaseKey, userId }),
	setLeadershipSnapshot: (snapshot) => set(snapshot),
	resetLeadership: () => set(initialLeadershipSnapshot),
	resetStore: () => set({
		leaseKey: null,
		userId: null,
		...initialLeadershipSnapshot,
	}),
}))

type WhiteboardTestHooks = {
	localSyncLeaderStore?: typeof useLocalSyncLeaderStore
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
	window.__whiteboardTestHooks.localSyncLeaderStore = useLocalSyncLeaderStore
}

attachTestHooks()
