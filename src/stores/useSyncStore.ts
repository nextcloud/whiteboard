/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import logger from '../utils/logger'
import { useWhiteboardConfigStore } from './useWhiteboardConfigStore'

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
	persistedRev: number
	lastServerUpdatedAt: number | null
	lastServerUpdatedBy: string | null

	// Actions
	setWorker: (worker: Worker | null) => void
	setIsWorkerReady: (ready: boolean) => void
	setPersistedMetadata: (meta: {
		persistedRev?: number
		updatedAt?: number | null
		updatedBy?: string | null
	}) => void
	resetPersistedMetadata: () => void

	// Worker functions
	initializeWorker: () => Worker | null
	terminateWorker: () => void
}

export const useSyncStore = create<SyncStore>((set, get) => ({
	// State
	worker: null,
	isWorkerReady: false,
	persistedRev: 0,
	lastServerUpdatedAt: null,
	lastServerUpdatedBy: null,

	// Actions
	setWorker: (worker) => set({ worker }),

	setIsWorkerReady: (ready) => {
		set({ isWorkerReady: ready })
	},

	setPersistedMetadata: (meta) => {
		set((state) => ({
			persistedRev: meta.persistedRev ?? state.persistedRev,
			lastServerUpdatedAt: Object.prototype.hasOwnProperty.call(meta, 'updatedAt')
				? meta.updatedAt ?? null
				: state.lastServerUpdatedAt,
			lastServerUpdatedBy: Object.prototype.hasOwnProperty.call(meta, 'updatedBy')
				? meta.updatedBy ?? null
				: state.lastServerUpdatedBy,
		}))
	},

	resetPersistedMetadata: () => {
		set({
			persistedRev: 0,
			lastServerUpdatedAt: null,
			lastServerUpdatedBy: null,
		})
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
					const currentFileId = useWhiteboardConfigStore.getState().fileId
					const messageFileId = typeof data.fileId === 'number' ? data.fileId : null
					const isActiveFileMessage = messageFileId === null || messageFileId === currentFileId

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
						if (isActiveFileMessage) {
							get().setPersistedMetadata({
								persistedRev: data.persistedRev,
								updatedAt: data.updatedAt,
								updatedBy: data.updatedBy,
							})
						}
						// Use the imported logSyncResult function
						logSyncResult('server', {
							status: data.conflict ? 'success after conflict' : 'success',
							elementsCount: data.elementsCount,
							error: null,
						})
						break

					case 'SERVER_SYNC_CONFLICT':
						if (isActiveFileMessage) {
							get().setPersistedMetadata({
								persistedRev: data.persistedRev,
								updatedAt: data.updatedAt,
								updatedBy: data.updatedBy,
							})
						}
						logger.warn('[SyncStore] Worker server sync conflict:', data.error)
						logSyncResult('server', {
							status: 'conflict',
							error: data.error,
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
				persistedRev: 0,
				lastServerUpdatedAt: null,
				lastServerUpdatedBy: null,
			})
		}
	},
}))
