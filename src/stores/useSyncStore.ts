/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { useWhiteboardStore } from './useWhiteboardStore'

export type SyncOperation = 'local' | 'server'
export type SyncStatus = 'syncing' | 'success' | 'error'

interface SyncStore {
	// Core state
	worker: Worker | null
	isWorkerReady: boolean
	syncStatus: Record<SyncOperation, SyncStatus | null>

	// Actions
	setWorker: (worker: Worker | null) => void
	setIsWorkerReady: (ready: boolean) => void
	updateSyncResult: (
		operation: SyncOperation,
		result: {
			status: SyncStatus
			error?: string | null
			elementsCount?: number | null
		},
	) => void

	// Status getter
	isReadyToSync: () => boolean
	isCurrentlySyncing: (operation: SyncOperation) => boolean

	// Worker functions
	initializeWorker: () => Worker | null
	terminateWorker: () => void
}

export const useSyncStore = create<SyncStore>((set, get) => ({
	// State
	worker: null,
	isWorkerReady: false,
	syncStatus: {
		local: null,
		server: null,
	},

	// Actions
	setWorker: (worker) => set({ worker }),

	setIsWorkerReady: (ready) => {
		set({ isWorkerReady: ready })
	},

	updateSyncResult: (operation, result) => {
		// Update the sync status in the state
		set((state) => ({
			syncStatus: {
				...state.syncStatus,
				[operation]: result.status,
			},
		}))

		console.log(
			`[SyncStore] ${operation} sync ${result.status}`,
			result.elementsCount ? `elements: ${result.elementsCount}` : '',
			result.error ? `error: ${result.error}` : '',
		)
	},

	// Status getters
	isReadyToSync: () => {
		const { isWorkerReady } = get()
		const { appStatus } = useWhiteboardStore.getState()
		return isWorkerReady && appStatus !== 'loading'
	},

	isCurrentlySyncing: (operation: SyncOperation): boolean => {
		const { syncStatus } = get()
		return syncStatus[operation] === 'syncing'
	},

	// Worker functions
	initializeWorker: () => {
		console.log('[SyncStore] Initializing sync worker')

		// If worker already exists, terminate it first
		if (get().worker) {
			get().terminateWorker()
		}

		// Reset the worker ready state
		set({ isWorkerReady: false })

		let syncWorker: Worker | null = null

		try {
			syncWorker = new Worker(
				new URL('../workers/syncWorker.ts', import.meta.url),
				{ type: 'module' },
			)
			console.log('[SyncStore] Worker initialized successfully')

			// Setup worker message handler
			if (syncWorker) {
				syncWorker.onmessage = (event) => {
					const { type, ...data } = event.data

					console.log(
						`[SyncStore] Received message from worker: ${type}`,
						data,
					)

					switch (type) {
					case 'INIT_COMPLETE':
						console.log(
							'[SyncStore] Worker initialization complete',
						)
						get().setIsWorkerReady(true)
						break

					case 'LOCAL_SYNC_COMPLETE':
						console.log(
							'[SyncStore] Worker completed local sync:',
							data,
						)
						get().updateSyncResult('local', {
							status: 'success',
							elementsCount: data.elementsCount,
							error: null,
						})
						break

					case 'LOCAL_SYNC_ERROR':
						console.error(
							'[SyncStore] Worker local sync error:',
							data.error,
						)
						get().updateSyncResult('local', {
							status: 'error',
							error: data.error,
						})
						break

					case 'SERVER_SYNC_COMPLETE':
						console.log(
							'[SyncStore] Worker completed server sync:',
							data,
						)
						get().updateSyncResult('server', {
							status: 'success',
							elementsCount: data.elementsCount,
							error: null,
						})
						break

					case 'SERVER_SYNC_ERROR':
						console.error(
							'[SyncStore] Worker server sync error:',
							data.error,
						)
						get().updateSyncResult('server', {
							status: 'error',
							error: data.error,
						})
						break

					default:
						console.warn(
							`[SyncStore] Unknown message from worker: ${type}`,
						)
					}
				}

				// Initialize the worker
				syncWorker.postMessage({
					type: 'INIT',
				})

				// Store the worker in the state
				set({ worker: syncWorker })
			} else {
				console.warn('[SyncStore] Worker not available, using fallback')
			}
		} catch (e) {
			console.error('[SyncStore] Failed to initialize worker:', e)
		}

		return syncWorker
	},

	terminateWorker: () => {
		const { worker } = get()
		if (worker) {
			worker.terminate()
			set({
				worker: null,
				isWorkerReady: false,
			})
			console.log('[SyncStore] Worker terminated')
		}
	},
}))
