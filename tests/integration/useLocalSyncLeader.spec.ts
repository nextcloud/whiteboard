import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createLocalSyncLeaderCoordinator,
	LOCAL_SYNC_LEADER_HEARTBEAT_MS,
	LOCAL_SYNC_LEADER_TTL_MS,
	type LocalSyncLeaderLease,
	type LocalSyncLeaderSnapshot,
} from '../../src/utils/localSyncLeaderCoordinator'

type StorageListener = (key: string | null, newValue: string | null) => void
type MessageListener = (event: MessageEvent<unknown>) => void

class SharedLeaderTestBus {

	private storage = new Map<string, string>()
	private storageListeners = new Map<string, StorageListener>()
	private channels = new Map<string, Set<TestBroadcastChannel>>()

	createTab(leaseKey: string, tabId: string, initialVisibility: 'visible' | 'hidden' = 'visible') {
		let visibilityState: 'visible' | 'hidden' = initialVisibility
		let snapshot: LocalSyncLeaderSnapshot = {
			isLocalLeader: false,
			isPassiveFollower: false,
			leaderTabId: null,
			leaderHeartbeatAt: null,
		}

		const coordinator = createLocalSyncLeaderCoordinator({
			leaseKey,
			tabId,
			env: {
				now: () => Date.now(),
				getVisibilityState: () => visibilityState,
				storage: {
					getItem: (key) => this.storage.get(key) ?? null,
					setItem: (key, value) => {
						this.storage.set(key, value)
						this.emitStorage(tabId, key, value)
					},
					removeItem: (key) => {
						this.storage.delete(key)
						this.emitStorage(tabId, key, null)
					},
				},
				createBroadcastChannel: (name) => {
					const channel = new TestBroadcastChannel(name, tabId, this)
					const existing = this.channels.get(name) ?? new Set<TestBroadcastChannel>()
					existing.add(channel)
					this.channels.set(name, existing)
					return channel
				},
				addStorageListener: (listener) => {
					this.storageListeners.set(tabId, (key, newValue) => {
						if (key === leaseKey) {
							listener(key, newValue)
						}
					})
					return () => {
						this.storageListeners.delete(tabId)
					}
				},
				setInterval,
				clearInterval,
			},
			onStateChange: (nextSnapshot) => {
				snapshot = nextSnapshot
			},
		})

		return {
			start: () => coordinator.start(),
			stop: () => coordinator.stop(),
			evaluate: (reason?: string) => coordinator.evaluate(reason),
			handleVisibilityChange: (visibility: 'visible' | 'hidden') => {
				visibilityState = visibility
				coordinator.handleVisibilityChange('test-visibility')
			},
			get snapshot() {
				return snapshot
			},
		}
	}

	seedLease(leaseKey: string, lease: LocalSyncLeaderLease) {
		this.storage.set(leaseKey, JSON.stringify(lease))
	}

	getLease(leaseKey: string) {
		const raw = this.storage.get(leaseKey)
		return raw ? JSON.parse(raw) as LocalSyncLeaderLease : null
	}

	postMessage(name: string, sourceTabId: string, payload: unknown) {
		for (const channel of this.channels.get(name) ?? []) {
			if (channel.tabId === sourceTabId) {
				continue
			}
			channel.receive(payload)
		}
	}

	removeChannel(name: string, channel: TestBroadcastChannel) {
		const channels = this.channels.get(name)
		channels?.delete(channel)
		if (channels?.size === 0) {
			this.channels.delete(name)
		}
	}

	private emitStorage(sourceTabId: string, key: string, newValue: string | null) {
		for (const [tabId, listener] of this.storageListeners.entries()) {
			if (tabId === sourceTabId) {
				continue
			}
			listener(key, newValue)
		}
	}

}

class TestBroadcastChannel {

	private listeners = new Set<MessageListener>()
	readonly name: string
	readonly tabId: string
	private readonly bus: SharedLeaderTestBus

	constructor(name: string, tabId: string, bus: SharedLeaderTestBus) {
		this.name = name
		this.tabId = tabId
		this.bus = bus
	}

	postMessage(message: unknown) {
		this.bus.postMessage(this.name, this.tabId, message)
	}

	addEventListener(_type: 'message', listener: MessageListener) {
		this.listeners.add(listener)
	}

	removeEventListener(_type: 'message', listener: MessageListener) {
		this.listeners.delete(listener)
	}

	close() {
		this.bus.removeChannel(this.name, this)
		this.listeners.clear()
	}

	receive(message: unknown) {
		for (const listener of this.listeners) {
			listener({ data: message } as MessageEvent<unknown>)
		}
	}

}

describe('useLocalSyncLeader coordinator', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('first tab becomes leader', () => {
		const bus = new SharedLeaderTestBus()
		const leaseKey = 'whiteboard-sync:42:user-a'
		const tabA = bus.createTab(leaseKey, 'tab-a')

		tabA.start()

		expect(tabA.snapshot.isLocalLeader).toBe(true)
		expect(tabA.snapshot.isPassiveFollower).toBe(false)
		expect(tabA.snapshot.leaderTabId).toBe('tab-a')
		expect(tabA.snapshot.leaderHeartbeatAt).not.toBeNull()
	})

	it('second tab becomes follower', () => {
		const bus = new SharedLeaderTestBus()
		const leaseKey = 'whiteboard-sync:42:user-a'
		const tabA = bus.createTab(leaseKey, 'tab-a')
		const tabB = bus.createTab(leaseKey, 'tab-b')

		tabA.start()
		tabB.start()

		expect(tabA.snapshot.isLocalLeader).toBe(true)
		expect(tabB.snapshot.isLocalLeader).toBe(false)
		expect(tabB.snapshot.isPassiveFollower).toBe(true)
		expect(tabB.snapshot.leaderTabId).toBe('tab-a')
	})

	it('leader close or unmount transfers leadership within the lease window', () => {
		const bus = new SharedLeaderTestBus()
		const leaseKey = 'whiteboard-sync:42:user-a'
		const tabA = bus.createTab(leaseKey, 'tab-a')
		const tabB = bus.createTab(leaseKey, 'tab-b')

		tabA.start()
		tabB.start()
		tabA.stop()

		expect(tabB.snapshot.isLocalLeader).toBe(true)
		expect(tabB.snapshot.leaderTabId).toBe('tab-b')
	})

	it('stale leader heartbeat is recovered', () => {
		const bus = new SharedLeaderTestBus()
		const leaseKey = 'whiteboard-sync:42:user-a'
		const now = Date.now()

		bus.seedLease(leaseKey, {
			tabId: 'stale-tab',
			updatedAt: now - LOCAL_SYNC_LEADER_TTL_MS - LOCAL_SYNC_LEADER_HEARTBEAT_MS,
			expiresAt: now - 1,
			visibilityState: 'visible',
		})

		const tabB = bus.createTab(leaseKey, 'tab-b')
		tabB.start()

		expect(tabB.snapshot.isLocalLeader).toBe(true)
		expect(bus.getLease(leaseKey)?.tabId).toBe('tab-b')
	})

	it('hidden leader stays authoritative until it stops or goes stale', () => {
		const bus = new SharedLeaderTestBus()
		const leaseKey = 'whiteboard-sync:42:user-a'
		const tabA = bus.createTab(leaseKey, 'tab-a', 'visible')
		const tabB = bus.createTab(leaseKey, 'tab-b', 'hidden')

		tabA.start()
		tabB.start()

		tabA.handleVisibilityChange('hidden')
		tabB.handleVisibilityChange('visible')

		expect(tabA.snapshot.isLocalLeader).toBe(true)
		expect(tabA.snapshot.leaderTabId).toBe('tab-a')
		expect(tabB.snapshot.isLocalLeader).toBe(false)
		expect(tabB.snapshot.isPassiveFollower).toBe(true)
		expect(tabB.snapshot.leaderTabId).toBe('tab-a')
	})

	it('same user on different fileIds does not interfere', () => {
		const bus = new SharedLeaderTestBus()
		const fileOneLeader = bus.createTab('whiteboard-sync:42:user-a', 'tab-a')
		const fileTwoLeader = bus.createTab('whiteboard-sync:99:user-a', 'tab-b')

		fileOneLeader.start()
		fileTwoLeader.start()

		expect(fileOneLeader.snapshot.isLocalLeader).toBe(true)
		expect(fileTwoLeader.snapshot.isLocalLeader).toBe(true)
		expect(fileOneLeader.snapshot.leaderTabId).toBe('tab-a')
		expect(fileTwoLeader.snapshot.leaderTabId).toBe('tab-b')
	})

	it('different users on the same fileId do not interfere', () => {
		const bus = new SharedLeaderTestBus()
		const userOneLeader = bus.createTab('whiteboard-sync:42:user-a', 'tab-a')
		const userTwoLeader = bus.createTab('whiteboard-sync:42:user-b', 'tab-b')

		userOneLeader.start()
		userTwoLeader.start()

		expect(userOneLeader.snapshot.isLocalLeader).toBe(true)
		expect(userTwoLeader.snapshot.isLocalLeader).toBe(true)
		expect(userOneLeader.snapshot.leaderTabId).toBe('tab-a')
		expect(userTwoLeader.snapshot.leaderTabId).toBe('tab-b')
	})
})
