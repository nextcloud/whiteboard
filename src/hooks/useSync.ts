/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect } from 'react'
import { throttle } from 'lodash'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { useSyncStore } from '../stores/useSyncStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { generateUrl } from '@nextcloud/router'
import { db } from '../database/db'
import { useNetworkStore } from '../stores/useNetworkStore'

const SERVER_SYNC_INTERVAL = 30000
const LOCAL_SYNC_INTERVAL = 1000

export function useSync() {
	const { fileId, isReadOnly, isDedicatedSyncer, appStatus, initialDataLoaded }
		= useWhiteboardStore()
	const { excalidrawAPI } = useExcalidrawStore()
	const { status } = useNetworkStore()

	const {
		initializeWorker,
		terminateWorker,
		updateSyncResult,
		isReadyToSync,
		isCurrentlySyncing,
	} = useSyncStore()

	useEffect(() => {
		console.log('[Sync] Initializing sync worker')
		initializeWorker()

		return () => {
			terminateWorker()
		}
	}, [initializeWorker, terminateWorker])

	const syncToLocal = useCallback(
		throttle(async () => {
			// Check if we should sync
			if (
				!excalidrawAPI
				|| !fileId
				|| !db
				|| !isReadyToSync()
				|| isCurrentlySyncing('local')
				|| appStatus !== 'ready'
				|| !initialDataLoaded // Don't sync until initial data is loaded
			) {
				console.log('[Sync] Local sync cannot be performed', {
					fileId,
					isReadyToSync: isReadyToSync(),
					isCurrentlySyncing: isCurrentlySyncing('local'),
					appStatus,
					initialDataLoaded,
				})
				return
			}

			const elements = excalidrawAPI?.getSceneElements() as any
			const appState = excalidrawAPI?.getAppState() as any
			const files = excalidrawAPI?.getFiles() as any

			// Check if we have any elements to sync
			if (elements.length === 0) {
				// Check if there's existing data before overwriting with empty data
				try {
					const existingData = await db.get(fileId)
					if (existingData && existingData.elements && existingData.elements.length > 0) {
						console.log('[Sync] Preventing sync of empty whiteboard over existing data')
						return
					}
				} catch (error) {
					console.error('[Sync] Error checking existing data:', error)
				}
			}

			try {
				console.log(
					`[Sync] Syncing ${elements.length} elements to IndexedDB`,
				)

				updateSyncResult('local', { status: 'syncing' })

				const filteredAppState = { ...appState }
				if (filteredAppState?.collaborators) {
					delete filteredAppState?.collaborators
				}

				const syncWorker = useSyncStore.getState().worker

				if (syncWorker) {
					console.log('[Sync] Syncing via worker')
					syncWorker.postMessage({
						type: 'SYNC_TO_LOCAL',
						fileId,
						elements,
						files,
						appState: filteredAppState,
					})
				} else {
					// Fallback to direct IndexedDB access
					console.log(
						'[Sync] Syncing directly to IndexedDB (fallback)',
					)
					db.put(fileId, elements, files, filteredAppState)
						.then(() => {
							updateSyncResult('local', {
								status: 'success',
								elementsCount: elements.length,
								error: null,
							})
							console.log(
								'[Sync] Local sync completed (fallback)',
							)
						})
						.catch((error) => {
							console.error(
								'[Sync] Error syncing to local storage:',
								error,
							)
							updateSyncResult('local', {
								status: 'error',
								error:
									error instanceof Error
										? error.message
										: String(error),
							})
						})
				}
			} catch (error) {
				console.error('[Sync] Error syncing data:', error)
				updateSyncResult('local', {
					status: 'error',
					error:
						error instanceof Error ? error.message : String(error),
				})
			}
		}, LOCAL_SYNC_INTERVAL),
		[
			fileId,
			excalidrawAPI,
			updateSyncResult,
			isCurrentlySyncing,
			db,
			appStatus,
			initialDataLoaded,
		],
	)

	const onChange = useCallback(() => {
		if (
			!isReadyToSync()
			|| !excalidrawAPI
			|| !fileId
			|| isCurrentlySyncing('local')
			|| !db
			|| appStatus !== 'ready'
			|| !initialDataLoaded // Don't sync until initial data is loaded
		) {
			// Only log if we're ready but initial data isn't loaded yet
			if (appStatus === 'ready' && !initialDataLoaded) {
				console.log('[Sync] Skipping onChange sync - waiting for initial data to load')
			}
			return
		}
		syncToLocal()
	}, [
		syncToLocal,
		fileId,
		excalidrawAPI,
		isReadyToSync,
		isCurrentlySyncing,
		db,
		appStatus,
		initialDataLoaded,
	])

	const syncToServer = useCallback(
		throttle(() => {
			if (
				!isReadyToSync()
				|| !excalidrawAPI
				|| !fileId
				|| !db
				|| isCurrentlySyncing('server')
				|| !isDedicatedSyncer
				|| isReadOnly
				|| appStatus !== 'ready'
				|| !initialDataLoaded // Don't sync until initial data is loaded
			) {
				console.log('[Sync] Server sync cannot be performed', {
					fileId,
					isReadyToSync: isReadyToSync(),
					isCurrentlySyncing: isCurrentlySyncing('server'),
					isDedicatedSyncer,
					isReadOnly,
					appStatus,
					initialDataLoaded,
				})
				return
			}

			const syncWorker = useSyncStore.getState().worker

			try {
				console.log('[Sync] Starting server sync')

				updateSyncResult('server', { status: 'syncing' })

				if (syncWorker) {
					console.log('[Sync] Syncing to server via worker')

					useJWTStore
						.getState()
						.getJWT()
						.then((jwt) => {
							if (!jwt) {
								console.error(
									'[Sync] Failed to obtain JWT token for server sync',
								)
								updateSyncResult('server', {
									status: 'error',
									error: 'Failed to obtain JWT token for server sync',
								})
								return
							}

							const { fileId }
								= useWhiteboardStore.getState()

							syncWorker.postMessage({
								type: 'SYNC_TO_SERVER',
								fileId,
								url: generateUrl(
									`apps/whiteboard/${fileId}`,
								),
								jwt,
								elements: excalidrawAPI?.getSceneElements() as any,
								files: excalidrawAPI?.getFiles() as any,
							})
						})
						.catch((error) => {
							console.error('[Sync] Error getting JWT:', error)
							updateSyncResult('server', {
								status: 'error',
								error:
									error instanceof Error
										? error.message
										: String(error),
							})
						})
				} else {
					// Fallback for direct API call (not implemented)
					console.warn(
						'[Sync] Direct API fallback for server sync not implemented',
					)
					updateSyncResult('server', {
						status: 'error',
						error: 'Worker not available and direct API fallback not implemented',
					})
				}
			} catch (error) {
				console.error('[Sync] Error in server sync:', error)
				updateSyncResult('server', {
					status: 'error',
					error:
						error instanceof Error ? error.message : String(error),
				})
			}
		}, SERVER_SYNC_INTERVAL),
		[
			fileId,
			excalidrawAPI,
			isReadyToSync,
			isCurrentlySyncing,
			isDedicatedSyncer,
			isReadOnly,
			db,
			appStatus,
		],
	)

	useEffect(() => {
		if (
			status !== 'offline'
			&& !isReadOnly
			&& isDedicatedSyncer
			&& isReadyToSync()
			&& appStatus === 'ready'
			&& initialDataLoaded // Don't sync until initial data is loaded
		) {
			console.log('[Sync] Starting periodic server sync')
			syncToServer()
		}
	}, [
		status,
		isReadOnly,
		isDedicatedSyncer,
		isReadyToSync,
		syncToServer,
		appStatus,
		initialDataLoaded,
	])

	useEffect(() => {
		const handleBeforeUnload = () => {
			if (excalidrawAPI && isReadyToSync() && initialDataLoaded) {
				console.log('[Sync] Flushing sync before unload')
				syncToLocal.flush()
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
		}
	}, [excalidrawAPI, syncToLocal, isReadyToSync, initialDataLoaded])

	return {
		onChange,
	}
}
