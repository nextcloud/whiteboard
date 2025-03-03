/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useCallback, useRef, useMemo } from 'react'
import type {
	BinaryFiles,
	ExcalidrawInitialDataState,
	AppState,
	BinaryFileData,
} from '@excalidraw/excalidraw/types/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { getRequestToken } from '@nextcloud/auth'
import { useJWTStore } from '../stores/useJwtStore'
import { db } from '../database/db'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { throttle } from 'lodash'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { useNetworkStore } from '../stores/useNetworkStore'
import { resolvablePromise } from '../utils'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import { restoreElements } from '@excalidraw/excalidraw'
import { reconcileElements } from '../util'

const SERVER_SYNC_INTERVAL = 60000
const LOCAL_SYNC_INTERVAL = 10000
const SERVER_REFRESH_INTERVAL = 60000

export function useWhiteboardData(
	fileId: number,
	publicSharingToken: string | null,
) {
	const initialDataState = useMemo(
		() => ({
			appState: {
				currentItemFontFamily: 3,
				currentItemStrokeWidth: 1,
				currentItemRoughness: 0,
			},
		}),
		[],
	)

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>
	}>({ promise: null! })

	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
		initialStatePromiseRef.current.promise.resolve(initialDataState)
	}

	const { executeWithJWT } = useJWTStore()
	const { excalidrawAPI, scrollToContent } = useExcalidrawStore()
	const { status, pendingSync, setStatus, setPendingSync }
		= useWhiteboardStore()
	const networkStatus = useNetworkStore((state) => state.status)

	const isReadOnlyRef = useRef(false)
	const isDedicatedSyncerRef = useRef(false)
	const socketRef = useRef<any>(null)

	const statusRef = useRef(status)
	const pendingSyncRef = useRef(pendingSync)
	const networkStatusRef = useRef(networkStatus)

	useEffect(() => {
		statusRef.current = status
		pendingSyncRef.current = pendingSync
		networkStatusRef.current = networkStatus
	}, [status, pendingSync, networkStatus])

	// Set up socket reference from collaboration hook
	useEffect(() => {
		const handleSocketRefUpdate = (event: CustomEvent) => {
			socketRef.current = event.detail

			if (socketRef.current) {
				isDedicatedSyncerRef.current = false

				socketRef.current.on('read-only', () => {
					isReadOnlyRef.current = true
					console.log('[Permissions] User has read-only access')
				})

				socketRef.current.on(
					'sync-designate',
					(data: { isSyncer: boolean }) => {
						isDedicatedSyncerRef.current = data.isSyncer
						console.log(
							`[Sync] ${data.isSyncer ? 'DESIGNATED as syncer' : 'NOT designated as syncer'}`,
						)
					},
				)
			}
		}

		window.addEventListener(
			'whiteboard-socket-ready',
			handleSocketRefUpdate as EventListener,
		)

		return () => {
			window.removeEventListener(
				'whiteboard-socket-ready',
				handleSocketRefUpdate as EventListener,
			)
		}
	}, [])

	// Load data from local IndexedDB storage
	const loadLocalData = useCallback(async () => {
		if (!excalidrawAPI) return null

		try {
			return await db.get(fileId)
		} catch (error) {
			console.error('Error loading local data:', error)
			return null
		}
	}, [excalidrawAPI, fileId])

	// Fetch server data only when needed (local data is empty)
	const fetchServerData = useCallback(async () => {
		if (!excalidrawAPI) return null

		try {
			return await executeWithJWT(
				`${fileId}`,
				publicSharingToken,
				async (token) => {
					let url = generateUrl(`apps/whiteboard/${fileId}`)
					if (publicSharingToken) {
						url += `?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
					}

					const response = await axios.get(url, {
						headers: {
							'Content-Type': 'application/json',
							'X-Requested-With': 'XMLHttpRequest',
							Authorization: `Bearer ${token}`,
							requesttoken: getRequestToken(),
						},
					})

					return response.data?.data || null
				},
			)
		} catch (error) {
			console.error('Error fetching server data:', error)
			return null
		}
	}, [excalidrawAPI, fileId, executeWithJWT, publicSharingToken])

	// Update the Excalidraw scene with elements and files
	const updateScene = useCallback(
		(elements: ExcalidrawElement[], files?: BinaryFiles) => {
			if (!excalidrawAPI) return

			excalidrawAPI.updateScene({
				elements,
			})

			if (files && Object.keys(files).length > 0) {
				const filesArray = Object.values(files).map(
					(file) =>
						({
							id: file.id,
							dataURL: file.dataURL,
							mimeType: file.mimeType,
							created: file.created,
							lastRetrieved: file.lastRetrieved,
						}) as BinaryFileData,
				)

				if (filesArray.length > 0) {
					excalidrawAPI.addFiles(filesArray)
				}
			}
		},
		[excalidrawAPI],
	)

	// Main effect for loading data with local-first approach
	useEffect(() => {
		const loadData = async () => {
			if (!excalidrawAPI) return

			console.log('[Data Loading] Starting data load process')
			setStatus('loading')

			try {
				// First try to load from local storage
				console.log('[Data Loading] Attempting to load from IndexedDB')
				const localData = await loadLocalData()

				if (
					localData
					&& localData.elements
					&& localData.elements.length > 0
				) {
					// If we have local data, use it
					console.log(
						`[Data Loading] Using local data (${localData.elements.length} elements)`,
					)
					updateScene(localData.elements, localData.files)
					scrollToContent()
				} else {
					// If no local data, fetch from server
					console.log(
						'[Data Loading] No local data found, fetching from server',
					)
					const serverData = await fetchServerData()

					if (serverData) {
						// Update the scene with server data
						const elements = serverData.elements || []
						console.log(
							`[Data Loading] Received server data (${elements.length} elements)`,
						)
						updateScene(elements, serverData.files)

						// Save server data to IndexedDB for future local-first access
						if (elements.length > 0) {
							console.log(
								'[Data Loading] Saving server data to IndexedDB',
							)
							await db.put(
								fileId,
								[...elements],
								serverData.files || {},
							)
						}
					} else {
						console.log('[Data Loading] No data found on server')
					}

					scrollToContent()
				}
			} catch (error) {
				console.error(
					'[Data Loading] Error loading whiteboard data:',
					error,
				)
			} finally {
				console.log('[Data Loading] Completed data loading process')
				setStatus('idle')
			}
		}

		if (excalidrawAPI) {
			loadData()
		}
	}, [
		excalidrawAPI,
		loadLocalData,
		fetchServerData,
		updateScene,
		setStatus,
		scrollToContent,
		fileId,
	])

	const syncToServer = useCallback(async () => {
		if (statusRef.current === 'syncing') {
			return
		}

		if (isReadOnlyRef.current) {
			console.log(
				'[Server Sync] Skipping - user has read-only permissions',
			)
			return
		}

		if (
			networkStatusRef.current === 'online'
			&& !isDedicatedSyncerRef.current
		) {
			console.log('[Server Sync] Skipping - not the designated syncer')
			return
		}

		console.log('[Server Sync] Starting server sync')
		setStatus('syncing')

		try {
			console.log('[Server Sync] Retrieving data from IndexedDB')
			const whiteboardData = await db.get(fileId)

			if (!whiteboardData) {
				console.warn('[Server Sync] No whiteboard data found to sync')
				return
			}

			console.log(
				`[Server Sync] Syncing ${whiteboardData.elements?.length || 0} elements to server`,
			)

			const startTime = performance.now()
			await executeWithJWT(
				`${fileId}`,
				publicSharingToken,
				async (token) => {
					let url = generateUrl(`apps/whiteboard/${fileId}`)
					if (publicSharingToken) {
						url += `?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
					}

					return axios.put(
						url,
						{ data: whiteboardData },
						{
							headers: {
								'Content-Type': 'application/json',
								'X-Requested-With': 'XMLHttpRequest',
								Authorization: `Bearer ${token}`,
								requesttoken: getRequestToken(),
							},
						},
					)
				},
			)
			const endTime = performance.now()

			setPendingSync(false)
			console.log(
				`[Server Sync] Successfully synced to server (took ${(endTime - startTime).toFixed(2)}ms)`,
			)
		} catch (error) {
			console.error('[Server Sync] Error syncing to server:', error)
		} finally {
			setStatus('idle')
			console.log('[Server Sync] Completed sync process')
		}
	}, [fileId, executeWithJWT, publicSharingToken, setStatus, setPendingSync])

	// Periodically sync to server if changes are pending
	useEffect(() => {
		if (status !== 'loading') {
			const interval = setInterval(() => {
				if (pendingSyncRef.current) {
					syncToServer()
				}
			}, SERVER_SYNC_INTERVAL)

			return () => clearInterval(interval)
		}
	}, [status, syncToServer])

	// Throttled function to update local data
	const updateLocalData = useMemo(
		() =>
			throttle(
				async (
					elements: readonly ExcalidrawElement[],
					files: BinaryFiles,
				) => {
					console.log(
						`[Local Sync] Saving ${elements.length} elements to IndexedDB`,
					)
					const startTime = performance.now()
					await db.put(fileId, [...elements], files)
					const endTime = performance.now()
					console.log(
						`[Local Sync] Saved to IndexedDB in ${(endTime - startTime).toFixed(2)}ms`,
					)
					setPendingSync(true)
				},
				LOCAL_SYNC_INTERVAL,
			),
		[fileId, setPendingSync],
	)

	// Set up event handlers for changes and page unload
	useEffect(() => {
		if (!excalidrawAPI) return

		const handleChange = (
			elements: readonly ExcalidrawElement[],
			appState: AppState,
			files: BinaryFiles,
		) => {
			if (!isReadOnlyRef.current) {
				updateLocalData(elements, files)
			}
		}

		excalidrawAPI.onChange(handleChange)

		const handleBeforeUnload = () => {
			if (excalidrawAPI && !isReadOnlyRef.current) {
				updateLocalData.flush()

				const currentElements = excalidrawAPI.getSceneElements()
				const currentFiles = excalidrawAPI.getFiles()

				db.put(fileId, [...currentElements], currentFiles)
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			updateLocalData.cancel()
		}
	}, [excalidrawAPI, updateLocalData, fileId])

	// Periodically fetch server data and update Excalidraw to ensure local data is up to date
	useEffect(() => {
		if (!excalidrawAPI || status === 'loading') return

		console.log('[Server Refresh] Setting up periodic server data fetch')

		const fetchAndUpdateFromServer = async () => {
			if (statusRef.current === 'syncing') return

			console.log('[Server Refresh] Fetching latest data from server')
			try {
				const serverData = await fetchServerData()

				if (serverData && serverData.elements) {
					console.log(
						`[Server Refresh] Received server data (${serverData.elements.length} elements)`,
					)

					const localElements
						= excalidrawAPI.getSceneElementsIncludingDeleted()
					const appState = excalidrawAPI.getAppState()
					const localFiles = excalidrawAPI.getFiles()

					// Restore elements if needed and reconcile with local changes
					const restoredRemoteElements = restoreElements(
						serverData.elements,
						null,
					)
					const reconciledElements = reconcileElements(
						localElements,
						restoredRemoteElements,
						appState,
					)

					// Merge local and server files
					const mergedFiles = {
						...(serverData.files || {}),
						...localFiles,
					}

					updateScene(reconciledElements, mergedFiles)

					console.log(
						'[Server Refresh] Updated Excalidraw with reconciled data',
					)
				}
			} catch (error) {
				console.error(
					'[Server Refresh] Error fetching server data:',
					error,
				)
			}
		}

		const interval = setInterval(
			fetchAndUpdateFromServer,
			SERVER_REFRESH_INTERVAL,
		)

		return () => clearInterval(interval)
	}, [excalidrawAPI, fetchServerData, updateScene, status])

	return { initialDataPromise: initialStatePromiseRef.current.promise }
}
