/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import logger from '../logger'

export type SyncOperation = 'local' | 'server' | 'websocket' | 'cursor'

// Utility function for logging sync results (moved outside the store)
export function logSyncResult(operation: SyncOperation, result: { status: string, error?: string | null, elementsCount?: number | null }) {
	logger.debug(
		`[SyncStore] ${operation} sync ${result.status}`,
		result.elementsCount ? `elements: ${result.elementsCount}` : '',
		result.error ? `error: ${result.error}` : '',
	)
}

interface SyncStore {
	// Core state
	worker: Worker | null
	isWorkerReady: boolean

	// Actions
	setWorker: (worker: Worker | null) => void
	setIsWorkerReady: (ready: boolean) => void

	// Worker functions
	initializeWorker: () => Worker | null
	terminateWorker: () => void
}

export const useSyncStore = create<SyncStore>((set, get) => ({
	// State
	worker: null,
	isWorkerReady: false,

	// Actions
	setWorker: (worker) => set({ worker }),

	setIsWorkerReady: (ready) => {
		set({ isWorkerReady: ready })
	},

	// Worker functions
	initializeWorker: () => {

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

			// Setup worker message handler
			if (syncWorker) {
				syncWorker.onmessage = (event) => {
					const { type, ...data } = event.data

					switch (type) {
					case 'INIT_COMPLETE':
						get().setIsWorkerReady(true)
						break

					case 'LOCAL_SYNC_COMPLETE':
						// Use the imported logSyncResult function
						logSyncResult('local', {
							status: 'success',
							elementsCount: data.elementsCount,
							error: null,
						})
						break

					case 'LOCAL_SYNC_ERROR':
						logger.error('[SyncStore] Worker local sync error:', data.error)
						// Use the imported logSyncResult function
						logSyncResult('local', {
							status: 'error',
							error: data.error,
						})
						break

					case 'SERVER_SYNC_COMPLETE':
						// Use the imported logSyncResult function
						logSyncResult('server', {
							status: 'success',
							elementsCount: data.elementsCount,
							error: null,
						})
						break

					case 'SERVER_SYNC_ERROR':
						logger.error('[SyncStore] Worker server sync error:', data.error)
						// Use the imported logSyncResult function
						logSyncResult('server', {
							status: 'error',
							error: data.error,
						})
						break

					default:
						logger.warn(`[SyncStore] Unknown message from worker: ${type}`)
					}
				}

				// Initialize the worker
				syncWorker.postMessage({
					type: 'INIT',
				})

				// Store the worker in the state
				set({ worker: syncWorker })
			}
		} catch (e) {
			logger.error('[SyncStore] Failed to initialize worker:', e)
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
		}
	},
}))
