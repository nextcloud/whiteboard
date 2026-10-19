/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import logger from '../utils/logger'
import { useWhiteboardConfigStore } from './useWhiteboardConfigStore.ts'

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
	savedSceneKey: string | null
	pausedFileId: number | null

	// Actions
	setWorker: (worker: Worker | null) => void
	setIsWorkerReady: (ready: boolean) => void

	// Worker functions
	initializeWorker: () => Worker | null
	flushBoard: (fileId: number, server?: boolean) => Promise<void>
	pauseSaves: (fileId: number) => Promise<void>
	resumeSaves: () => void
}

// An upload that takes longer fails the restore waiting for it
const SERVER_FLUSH_TIMEOUT = 60_000

const pendingFlushes = new Map<number, () => void>()
let lastFlushId = 0

function resolvePendingFlushes() {
	pendingFlushes.forEach((resolve) => resolve())
	pendingFlushes.clear()
}

export const useSyncStore = create<SyncStore>((set, get) => ({
	// State
	worker: null,
	isWorkerReady: false,
	savedSceneKey: null,
	pausedFileId: null,

	// Actions
	setWorker: (worker) => set({ worker }),

	setIsWorkerReady: (ready) => {
		set({ isWorkerReady: ready })
	},

	// Worker functions
	initializeWorker: () => {
		// One worker per page, so saves of a board stay in order across close and reopen
		const existingWorker = get().worker
		if (existingWorker) {
			return existingWorker
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
							if (data.fileId === useWhiteboardConfigStore.getState().fileId) {
								set({ savedSceneKey: data.sceneKey })
							}
							// Use the imported logSyncResult function
							logSyncResult('server', {
								status: 'success',
								elementsCount: data.elementsCount,
								error: null,
							})
							break

						case 'FLUSH_COMPLETE':
							pendingFlushes.get(data.id)?.()
							pendingFlushes.delete(data.id)
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

				// A worker that failed to load is replaced on the next mount
				const loadingWorker = syncWorker
				loadingWorker.onerror = (event) => {
					if (get().worker !== loadingWorker || get().isWorkerReady) {
						return
					}
					logger.error('[SyncStore] Worker failed to load:', event.message)
					loadingWorker.terminate()
					set({ worker: null })
					// Its queued saves will never run, so nothing is left to wait for
					resolvePendingFlushes()
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

	flushBoard: (fileId, server = false) => {
		const worker = get().worker
		if (!worker) {
			return Promise.resolve()
		}
		const id = ++lastFlushId
		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			if (server) {
				timer = setTimeout(() => {
					pendingFlushes.delete(id)
					reject(new Error('The board is still saving'))
				}, SERVER_FLUSH_TIMEOUT)
			}
			pendingFlushes.set(id, () => {
				clearTimeout(timer)
				resolve()
			})
			worker.postMessage({ type: 'FLUSH', fileId, id, server })
		})
	},

	// Stops saving the board and waits for the saves it already queued
	pauseSaves: (fileId) => {
		set({ pausedFileId: fileId })
		return get().flushBoard(fileId, true)
	},

	resumeSaves: () => set({ pausedFileId: null }),
}))
