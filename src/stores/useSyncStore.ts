/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { db } from '../database/db'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles, AppState } from '@excalidraw/excalidraw/types/types'
import { useWhiteboardStore } from './useWhiteboardStore'
import { generateUrl } from '@nextcloud/router'
import { useJWTStore } from './useJwtStore'

export type SyncStatus = 'idle' | 'syncing' | 'error'

let syncWorker: Worker | null = null

try {
	syncWorker = new Worker(
		new URL('../workers/syncWorker.ts', import.meta.url),
		{ type: 'module' },
	)
	console.log('[SyncStore] Sync worker initialized')
} catch (e) {
	console.error('[SyncStore] Failed to initialize sync worker:', e)
}

export const dispatchEvent = (
	type: string,
	detail: Record<string, unknown> = {},
) => {
	try {
		const event = new CustomEvent(`whiteboard:sync:${type}`, {
			detail,
			bubbles: true,
			cancelable: true,
		})
		document.dispatchEvent(event)
	} catch (e) {
		console.error('[SyncStore] Failed to dispatch event:', e)
	}
}

interface SyncStore {
	// State
	localSyncStatus: SyncStatus
	serverSyncStatus: SyncStatus
	lastLocalSyncTime: number | null
	pendingServerSync: boolean
	lastServerSyncTime: number | null

	// Actions
	initialize: () => void
	syncToLocal: (
		elements: ExcalidrawElement[],
		files: BinaryFiles,
		appState: AppState,
	) => void
	syncToServer: () => Promise<boolean>
	setPendingServerSync: (pending: boolean) => void
}

export const useSyncStore = create<SyncStore>((set, get) => ({
	// State
	localSyncStatus: 'idle',
	serverSyncStatus: 'idle',
	lastLocalSyncTime: null,
	pendingServerSync: false,
	lastServerSyncTime: null,

	// Actions
	initialize: () => {
		console.log('[SyncStore] Initializing sync store')

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
					break

				case 'LOCAL_SYNC_COMPLETE':
					console.log(
						'[SyncStore] Worker completed local sync:',
						data,
					)
					set({
						localSyncStatus: 'idle',
						lastLocalSyncTime: Date.now(),
						pendingServerSync: true,
					})
					dispatchEvent('sync_complete', {
						success: true,
						operation: 'local',
						...data,
					})
					break

				case 'SERVER_SYNC_COMPLETE':
					console.log(
						'[SyncStore] Worker completed server sync:',
						data,
					)
					set({
						serverSyncStatus: 'idle',
						pendingServerSync: false,
						lastServerSyncTime: Date.now(),
					})
					dispatchEvent('sync_complete', {
						success: data.success,
						operation: 'server',
						...data,
					})
					break

				case 'ERROR':
					console.error('[SyncStore] Worker error:', data)
					if (data.operation === 'SYNC_TO_LOCAL') {
						set({ localSyncStatus: 'error' })
					} else if (data.operation === 'SYNC_TO_SERVER') {
						set({
							serverSyncStatus: 'error',
							pendingServerSync: true,
						})
					}
					dispatchEvent('sync_error', data)
					break

				default:
					console.warn(
						`[SyncStore] Unknown message from worker: ${type}`,
						data,
					)
				}
			}

			syncWorker.postMessage({
				type: 'INIT',
			})
		} else {
			console.warn('[SyncStore] Worker not available, using fallback')
		}
	},

	syncToLocal: (elements, files, appState) => {
		const { localSyncStatus } = get()

		if (localSyncStatus === 'syncing') {
			return
		}

		const { fileId } = useWhiteboardStore.getState()

		set({ localSyncStatus: 'syncing' })
		dispatchEvent('sync_start', { operation: 'local' })

		if (syncWorker) {
			console.log(
				`[SyncStore] Syncing ${elements.length} elements to local storage via worker`,
			)
			syncWorker.postMessage({
				type: 'SYNC_TO_LOCAL',
				fileId,
				elements,
				files,
				appState,
			})
		} else {
			// Fallback to direct IndexedDB access
			console.log(
				`[SyncStore] Syncing ${elements.length} elements to local storage directly`,
			)
			db.put(fileId, elements, files, appState)
				.then(() => {
					set({
						localSyncStatus: 'idle',
						lastLocalSyncTime: Date.now(),
						pendingServerSync: true,
					})
					dispatchEvent('sync_complete', {
						success: true,
						operation: 'local',
						elementsCount: elements.length,
					})
				})
				.catch((error) => {
					console.error(
						'[SyncStore] Error syncing to local storage:',
						error,
					)
					set({ localSyncStatus: 'error' })
					dispatchEvent('sync_error', {
						error:
							error instanceof Error
								? error.message
								: String(error),
						operation: 'local_sync',
					})
				})
		}
	},

	syncToServer: async () => {
		const { serverSyncStatus } = get()

		if (serverSyncStatus === 'syncing') {
			return false
		}

		const { fileId, isReadOnly, isDedicatedSyncer } = useWhiteboardStore.getState()

		if (isReadOnly) {
			console.log(
				'[Server Sync] Skipping - user has read-only permissions',
			)
			return false
		}

		if (!isDedicatedSyncer) {
			console.log('[Server Sync] Skipping - not the designated syncer')
			return false
		}

		if (!navigator.onLine) {
			set({ pendingServerSync: true })
			return false
		}

		set({ serverSyncStatus: 'syncing' })
		dispatchEvent('sync_start', { operation: 'server' })

		try {
			const localData = await db.get(fileId)

			if (!localData?.elements?.length) {
				set({ serverSyncStatus: 'idle' })
				return false
			}

			const url = generateUrl(`/apps/whiteboard/${fileId}`)

			if (syncWorker) {
				console.log('[SyncStore] Syncing to server via worker')

				const jwt = await useJWTStore.getState().getJWT()
				if (!jwt) {
					throw new Error('Failed to obtain JWT token for server sync')
				}

				syncWorker.postMessage({
					type: 'SYNC_TO_SERVER',
					fileId,
					url,
					elements: localData.elements,
					files: localData.files,
					jwt,
				})

				return true
			} else {
				console.log('[SyncStore] Syncing to server directly')

				return await useJWTStore.getState().executeWithJWT(async (token) => {
					const response = await fetch(url, {
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							'X-Requested-With': 'XMLHttpRequest',
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							data: {
								elements: localData.elements,
								files: localData.files,
							},
						}),
					})

					if (response.ok) {
						set({
							serverSyncStatus: 'idle',
							pendingServerSync: false,
							lastServerSyncTime: Date.now(),
						})

						dispatchEvent('sync_complete', {
							success: true,
							operation: 'server',
							elementsCount: localData.elements.length,
						})

						return true
					}

					throw new Error('Server sync failed')
				})
			}
		} catch (error) {
			console.error('[Server Sync] Error syncing to server:', error)
			set({
				serverSyncStatus: 'error',
				pendingServerSync: true,
			})

			dispatchEvent('sync_error', {
				error: error instanceof Error ? error.message : String(error),
				operation: 'server_sync',
			})

			return false
		}
	},

	setPendingServerSync: (pending) => {
		set({ pendingServerSync: pending })
	},
}))
