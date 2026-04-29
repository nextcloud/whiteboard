/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import {
	getStableLocalSyncTabId,
	useLocalSyncLeaderStore,
} from '../stores/useLocalSyncLeaderStore'
import logger from '../utils/logger'
import {
	createLocalSyncLeaderCoordinator,
	getLocalSyncLeaderLeaseKey,
	normalizeVisibilityState,
	type LocalSyncLeaderChannel,
	type LocalSyncLeaderCoordinator,
	type LocalSyncLeaderEnvironment,
} from '../utils/localSyncLeaderCoordinator'
export {
	createLocalSyncLeaderCoordinator,
	getLocalSyncLeaderLeaseKey,
	LOCAL_SYNC_LEADER_HEARTBEAT_MS,
	LOCAL_SYNC_LEADER_TTL_MS,
	type LocalSyncLeaderChannel,
	normalizeVisibilityState,
	type LocalSyncLeaderCoordinator,
	type LocalSyncLeaderEnvironment,
	type LocalSyncLeaderLease,
	type LocalSyncLeaderSnapshot,
} from '../utils/localSyncLeaderCoordinator'

const createBrowserEnvironment = (leaseKey: string): LocalSyncLeaderEnvironment | null => {
	if (typeof window === 'undefined' || typeof document === 'undefined') {
		return null
	}

	return {
		now: () => Date.now(),
		getVisibilityState: () => normalizeVisibilityState(document.visibilityState),
		storage: window.localStorage,
		createBroadcastChannel: typeof BroadcastChannel === 'function'
			? (name) => new BroadcastChannel(name) as LocalSyncLeaderChannel
			: undefined,
		addStorageListener: (listener) => {
			const handleStorage = (event: StorageEvent) => {
				if (event.key !== leaseKey) {
					return
				}

				listener(event.key, event.newValue)
			}

			window.addEventListener('storage', handleStorage)
			return () => window.removeEventListener('storage', handleStorage)
		},
		setInterval: window.setInterval.bind(window),
		clearInterval: window.clearInterval.bind(window),
	}
}

let activeCoordinator: LocalSyncLeaderCoordinator | null = null

export const yieldLocalSyncLeader = (reason = 'external-yield') => {
	activeCoordinator?.yieldLeadership(reason)
}

export function useLocalSyncLeader() {
	const { fileId, isVersionPreview } = useWhiteboardConfigStore(
		useShallow(state => ({
			fileId: state.fileId,
			isVersionPreview: state.isVersionPreview,
		})),
	)

	const {
		parseJwt,
		getJWT,
		token,
	} = useJWTStore(
		useShallow((state) => ({
			parseJwt: state.parseJwt,
			getJWT: state.getJWT,
			token: fileId ? state.tokens[fileId] ?? null : null,
		})),
	)

	const {
		tabId,
		...storeSnapshot
	} = useLocalSyncLeaderStore(
		useShallow(state => ({
			tabId: state.tabId,
			isLocalLeader: state.isLocalLeader,
			isPassiveFollower: state.isPassiveFollower,
			leaderTabId: state.leaderTabId,
			leaderHeartbeatAt: state.leaderHeartbeatAt,
		})),
	)

	const userId = useMemo(() => {
		if (!token) {
			return null
		}

		const parsed = parseJwt(token)
		return parsed?.user?.id ?? parsed?.userid ?? null
	}, [parseJwt, token])

	useEffect(() => {
		if (!fileId || isVersionPreview || userId) {
			return
		}

		getJWT().catch((error) => {
			logger.warn('[LocalLeader] Failed to load JWT for local leader coordination', error)
		})
	}, [fileId, getJWT, isVersionPreview, userId])

	useEffect(() => {
		const configStore = useWhiteboardConfigStore.getState()
		const leaderStore = useLocalSyncLeaderStore.getState()
		const resetLeaderScope = () => {
			configStore.setPassiveFollower(false)
			leaderStore.resetStore()
		}

		if (!fileId || !userId || isVersionPreview) {
			activeCoordinator?.stop()
			activeCoordinator = null
			resetLeaderScope()
			return
		}

		const leaseKey = getLocalSyncLeaderLeaseKey(fileId, userId)
		const env = createBrowserEnvironment(leaseKey)

		if (!env) {
			resetLeaderScope()
			return
		}

		leaderStore.setScope({ leaseKey, userId })
		const coordinator = createLocalSyncLeaderCoordinator({
			leaseKey,
			tabId: tabId || getStableLocalSyncTabId(),
			env,
			onStateChange: (snapshot) => {
				useLocalSyncLeaderStore.getState().setLeadershipSnapshot(snapshot)
				useWhiteboardConfigStore.getState().setPassiveFollower(snapshot.isPassiveFollower)
			},
			log: (...args) => logger.debug(...args),
		})

		activeCoordinator?.stop()
		activeCoordinator = coordinator
		coordinator.start()

		const handleVisibilityChange = () => {
			coordinator.handleVisibilityChange('document')
		}

		document.addEventListener('visibilitychange', handleVisibilityChange)

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange)
			if (activeCoordinator === coordinator) {
				activeCoordinator = null
			}
			coordinator.stop()
			resetLeaderScope()
		}
	}, [fileId, isVersionPreview, tabId, userId])

	return storeSnapshot
}
