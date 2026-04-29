/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const LOCAL_SYNC_LEADER_HEARTBEAT_MS = 1000
export const LOCAL_SYNC_LEADER_TTL_MS = 3000

type LocalSyncLeaderVisibilityState = 'hidden' | 'visible'

export type LocalSyncLeaderLease = {
	tabId: string
	expiresAt: number
	updatedAt: number
	visibilityState: LocalSyncLeaderVisibilityState
}

type LocalSyncLeaderMessage = {
	type: 'lease-updated' | 'lease-yielded'
	leaseKey: string
	sourceTabId: string
	lease?: LocalSyncLeaderLease | null
}

type LocalSyncLeaderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type LocalSyncLeaderSnapshot = {
	isLocalLeader: boolean
	isPassiveFollower: boolean
	leaderTabId: string | null
	leaderHeartbeatAt: number | null
}

export type LocalSyncLeaderChannel = {
	postMessage: (message: LocalSyncLeaderMessage) => void
	addEventListener: (type: 'message', listener: (event: MessageEvent<LocalSyncLeaderMessage>) => void) => void
	removeEventListener: (type: 'message', listener: (event: MessageEvent<LocalSyncLeaderMessage>) => void) => void
	close: () => void
}

export type LocalSyncLeaderEnvironment = {
	now: () => number
	getVisibilityState: () => LocalSyncLeaderVisibilityState
	storage: LocalSyncLeaderStorage
	createBroadcastChannel?: (name: string) => LocalSyncLeaderChannel | null
	addStorageListener?: (listener: (key: string | null, newValue: string | null) => void) => () => void
	setInterval: typeof globalThis.setInterval
	clearInterval: typeof globalThis.clearInterval
}

type LocalSyncLeaderCoordinatorOptions = {
	leaseKey: string
	tabId: string
	env: LocalSyncLeaderEnvironment
	heartbeatMs?: number
	ttlMs?: number
	onStateChange: (snapshot: LocalSyncLeaderSnapshot) => void
	log?: (...args: unknown[]) => void
}

export type LocalSyncLeaderCoordinator = {
	start: () => void
	stop: () => void
	evaluate: (reason?: string) => void
	yieldLeadership: (reason?: string) => void
	handleVisibilityChange: (reason?: string) => void
}

export const getLocalSyncLeaderLeaseKey = (fileId: number, userId: string) => `whiteboard-sync:${fileId}:${userId}`

export const normalizeVisibilityState = (visibilityState: string | undefined): LocalSyncLeaderVisibilityState => (
	visibilityState === 'visible' ? 'visible' : 'hidden'
)

const parseLease = (value: string | null): LocalSyncLeaderLease | null => {
	if (!value) {
		return null
	}

	try {
		const parsed = JSON.parse(value) as Partial<LocalSyncLeaderLease>
		if (
			typeof parsed?.tabId !== 'string'
			|| typeof parsed?.expiresAt !== 'number'
			|| typeof parsed?.updatedAt !== 'number'
		) {
			return null
		}

		return {
			tabId: parsed.tabId,
			expiresAt: parsed.expiresAt,
			updatedAt: parsed.updatedAt,
			visibilityState: normalizeVisibilityState(parsed.visibilityState),
		}
	} catch {
		return null
	}
}

const isLeaseStale = (lease: LocalSyncLeaderLease | null, now: number) => (
	!lease || lease.expiresAt <= now
)

export const createLocalSyncLeaderCoordinator = ({
	leaseKey,
	tabId,
	env,
	heartbeatMs = LOCAL_SYNC_LEADER_HEARTBEAT_MS,
	ttlMs = LOCAL_SYNC_LEADER_TTL_MS,
	onStateChange,
	log = () => {},
}: LocalSyncLeaderCoordinatorOptions): LocalSyncLeaderCoordinator => {
	let isRunning = false
	let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null
	let channel: LocalSyncLeaderChannel | null = null
	let removeStorageListener: (() => void) | null = null
	let currentSnapshot: LocalSyncLeaderSnapshot = {
		isLocalLeader: false,
		isPassiveFollower: false,
		leaderTabId: null,
		leaderHeartbeatAt: null,
	}

	const readLease = () => parseLease(env.storage.getItem(leaseKey))

	const buildLease = (now: number): LocalSyncLeaderLease => ({
		tabId,
		updatedAt: now,
		expiresAt: now + ttlMs,
		visibilityState: env.getVisibilityState(),
	})

	const commitSnapshot = (snapshot: LocalSyncLeaderSnapshot) => {
		const hasChanged = snapshot.isLocalLeader !== currentSnapshot.isLocalLeader
			|| snapshot.isPassiveFollower !== currentSnapshot.isPassiveFollower
			|| snapshot.leaderTabId !== currentSnapshot.leaderTabId
			|| snapshot.leaderHeartbeatAt !== currentSnapshot.leaderHeartbeatAt

		if (!hasChanged) {
			return
		}

		currentSnapshot = snapshot
		onStateChange(snapshot)
	}

	const applyLease = (lease: LocalSyncLeaderLease | null) => {
		if (!isRunning) {
			return
		}

		commitSnapshot({
			isLocalLeader: lease?.tabId === tabId,
			isPassiveFollower: lease?.tabId !== tabId,
			leaderTabId: lease?.tabId ?? null,
			leaderHeartbeatAt: lease?.updatedAt ?? null,
		})
	}

	const publish = (type: LocalSyncLeaderMessage['type'], lease: LocalSyncLeaderLease | null = null) => {
		channel?.postMessage({
			type,
			leaseKey,
			sourceTabId: tabId,
			lease,
		})
	}

	const writeLease = (lease: LocalSyncLeaderLease, reason: string) => {
		env.storage.setItem(leaseKey, JSON.stringify(lease))
		log(`[LocalLeader] ${reason}`, lease)
		publish('lease-updated', lease)
		applyLease(lease)
	}

	const clearLeaseIfOwned = (reason: string) => {
		const existingLease = readLease()
		if (existingLease?.tabId !== tabId) {
			return
		}

		env.storage.removeItem(leaseKey)
		log(`[LocalLeader] ${reason}`, existingLease)
		publish('lease-yielded', null)
	}

	const evaluate = (reason = 'evaluate') => {
		if (!isRunning) {
			return
		}

		const now = env.now()
		const ownLease = buildLease(now)
		const existingLease = readLease()

		if (existingLease?.tabId === tabId) {
			writeLease(ownLease, `${reason}:heartbeat`)
			return
		}

		if (!isLeaseStale(existingLease, now) && existingLease) {
			log('[LocalLeader] Existing leader retained', { reason, existingLease })
			applyLease(existingLease)
			return
		}

		writeLease(ownLease, `${reason}:claim`)
	}

	const handleChannelMessage = (event: MessageEvent<LocalSyncLeaderMessage>) => {
		const message = event.data
		if (!message || message.leaseKey !== leaseKey || message.sourceTabId === tabId) {
			return
		}

		evaluate(`broadcast:${message.type}`)
	}

	const handleVisibilityChange = (reason = 'visibilitychange') => {
		if (!isRunning) {
			return
		}

		const existingLease = readLease()
		if (existingLease?.tabId === tabId) {
			writeLease(buildLease(env.now()), `${reason}:visibility`)
			return
		}

		if (env.getVisibilityState() === 'visible') {
			evaluate(`${reason}:visible`)
		}
	}

	return {
		start() {
			if (isRunning) {
				return
			}

			isRunning = true
			channel = env.createBroadcastChannel?.(leaseKey) ?? null
			channel?.addEventListener('message', handleChannelMessage)
			removeStorageListener = env.addStorageListener?.(() => {
				evaluate('storage')
			}) ?? null
			heartbeatTimer = env.setInterval(() => {
				evaluate('interval')
			}, heartbeatMs)

			evaluate('start')
		},

		stop() {
			if (!isRunning) {
				return
			}

			clearLeaseIfOwned('stop:release')

			isRunning = false

			if (heartbeatTimer) {
				env.clearInterval(heartbeatTimer)
				heartbeatTimer = null
			}

			if (channel) {
				channel.removeEventListener('message', handleChannelMessage)
				channel.close()
				channel = null
			}

			removeStorageListener?.()
			removeStorageListener = null

			currentSnapshot = {
				isLocalLeader: false,
				isPassiveFollower: false,
				leaderTabId: null,
				leaderHeartbeatAt: null,
			}
			onStateChange(currentSnapshot)
		},

		evaluate,

		yieldLeadership(reason = 'yield') {
			if (!isRunning) {
				return
			}

			clearLeaseIfOwned(`${reason}:release`)
			commitSnapshot({
				isLocalLeader: false,
				isPassiveFollower: false,
				leaderTabId: null,
				leaderHeartbeatAt: null,
			})
		},

		handleVisibilityChange,
	}
}
