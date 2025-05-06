/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useSyncStore } from '../stores/useSyncStore'
import { db } from '../database/db'
// @ts-expect-error - Type definitions issue with @nextcloud/router
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import { initialDataState } from '../App'

export function useBoardDataManager() {
	const [isLoading, setIsLoading] = useState(true)

	const {
		fileId,
		resolveInitialData,
	} = useWhiteboardConfigStore(useShallow(state => ({
		fileId: state.fileId,
		resolveInitialData: state.resolveInitialData,
	})))

	const fetchDataFromServer = useCallback(async (fileId: number) => {
		console.log('[BoardDataManager] Fetching data from Nextcloud server for fileId:', fileId)
		try {
			const jwt = await useJWTStore.getState().getJWT()
			if (!jwt) {
				console.error('[BoardDataManager] Failed to get JWT token for server data fetch')
				return null
			}

			const url = generateUrl(`apps/whiteboard/${fileId}`)
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${jwt}`,
				},
			})

			if (!response.ok) {
				console.error(`[BoardDataManager] Server responded with status: ${response.status} when fetching data`)
				return null
			}

			const responseData = await response.json()
			if (!responseData || !responseData.data) {
				console.error('[BoardDataManager] Invalid response data from server:', responseData)
				return null
			}

			console.log('[BoardDataManager] Successfully fetched data from server:', {
				elementCount: responseData.data.elements?.length || 0,
			})

			return responseData.data
		} catch (error) {
			console.error('[BoardDataManager] Error fetching data from server:', error)
			return null
		}
	}, [])

	const loadBoard = useCallback(async () => {
		if (!fileId) {
			console.warn('[BoardDataManager] No fileId provided, cannot load data')
			resolveInitialData(initialDataState)
			setIsLoading(false)
			return
		}

		console.log('[BoardDataManager] Loading data for fileId:', fileId)
		try {
			const defaultSettings = {
				currentItemFontFamily: 3,
				currentItemStrokeWidth: 1,
				currentItemRoughness: 0,
			}

			const localData = await db.get(fileId)
			let shouldUseLocalData = false
			let shouldFetchFromServer = false

			if (localData) {
				console.log('[BoardDataManager] Local data retrieved:', {
					elementCount: localData.elements?.length || 0,
					savedAt: localData.savedAt ? new Date(localData.savedAt).toISOString() : 'unknown',
					fileId: localData.id,
				})

				// Check if local data is valid and has elements
				if (localData.elements && Array.isArray(localData.elements)) {
					if (localData.elements.length > 0) {
						// Local data has elements, use it
						shouldUseLocalData = true
						console.log('[BoardDataManager] Local data has elements, will use it')
					} else {
						// Local data exists but has no elements, might be empty
						// We should check the server for data
						console.log('[BoardDataManager] Local data exists but has no elements, will check server')
						shouldFetchFromServer = true
					}
				} else {
					// Invalid local data, check server
					console.log('[BoardDataManager] Invalid local data structure, will check server')
					shouldFetchFromServer = true
				}
			} else {
				// No local data found, check server
				console.log('[BoardDataManager] No local data found, will check server')
				shouldFetchFromServer = true
			}

			let serverData = null

			if (shouldFetchFromServer) {
				serverData = await fetchDataFromServer(fileId)

				if (serverData && serverData.elements && Array.isArray(serverData.elements)) {
					console.log('[BoardDataManager] Using data from server and saving to IndexedDB')

					// Save server data to IndexedDB for future use
					await db.put(
						fileId,
						serverData.elements,
						serverData.files || {},
						serverData.appState,
					)

					// Use server data instead of local data
					shouldUseLocalData = false
				} else {
					console.log('[BoardDataManager] No valid data from server, will use empty state')
				}
			}

			// Determine which data to use
			if (shouldUseLocalData && localData) {
				// Use local data
				const elements = localData.elements
				const finalAppState = { ...defaultSettings, ...(localData.appState || {}) }
				const files = localData.files || {}

				console.log(`[BoardDataManager] Loading data from local storage: ${elements.length} elements, ${Object.keys(files).length} files`)

				// Force a small delay to ensure the component is ready to receive the data
				setTimeout(() => {
					resolveInitialData({
						elements,
						appState: finalAppState,
						files,
						scrollToContent: true,
					})
					console.log('[BoardDataManager] Loaded data from local storage with merged settings')
					setIsLoading(false)
				}, 50)
			} else if (serverData && serverData.elements) {
				// Use server data
				const elements = serverData.elements
				const finalAppState = { ...defaultSettings, ...(serverData.appState || {}) }
				const files = serverData.files || {}

				console.log(`[BoardDataManager] Loading data from server: ${elements.length} elements, ${Object.keys(files || {}).length} files`)

				// Force a small delay to ensure the component is ready to receive the data
				setTimeout(() => {
					resolveInitialData({
						elements,
						appState: finalAppState,
						files,
						scrollToContent: true,
					})
					console.log('[BoardDataManager] Loaded data from server with merged settings')
					setIsLoading(false)
				}, 50)
			} else {
				// No valid data from either source, use defaults
				console.log('[BoardDataManager] No valid data found in local storage or server, using defaults')
				// Force a small delay to ensure the component is ready to receive the data
				setTimeout(() => {
					resolveInitialData(initialDataState)
					setIsLoading(false)
				}, 50)
			}
		} catch (error) {
			console.error('[BoardDataManager] Error loading data:', error)
			// Force a small delay to ensure the component is ready to receive the data
			setTimeout(() => {
				resolveInitialData(initialDataState)
				setIsLoading(false)
			}, 50)
		}
	}, [fileId, resolveInitialData, fetchDataFromServer])

	const saveOnUnmount = useCallback(() => {
		const api = useExcalidrawStore.getState().excalidrawAPI
		const currentIsReadOnly = useWhiteboardConfigStore.getState().isReadOnly

		if (api && !currentIsReadOnly) {
			console.log('[App] Saving final state on unmount')

			const currentFileId = useWhiteboardConfigStore.getState().fileId
			const currentWorker = useSyncStore.getState().worker
			const currentIsWorkerReady = useSyncStore.getState().isWorkerReady

			if (currentIsWorkerReady && currentWorker && currentFileId) {
				try {
					const elements = api.getSceneElementsIncludingDeleted()
					const appState = api.getAppState()
					const files = api.getFiles()
					// Create a new object without the properties we want to exclude
					const filteredAppState = {
						...appState,
						collaborators: undefined,
						selectedElementIds: undefined,
					}

					console.log(`[App] Sending final sync with ${elements.length} elements before unmount`)

					// Set up a one-time message handler to detect when sync is complete
					const messageHandler = (event: MessageEvent) => {
						if (event.data.type === 'LOCAL_SYNC_COMPLETE') {
							console.log('[App] Final sync completed successfully')
							currentWorker.removeEventListener('message', messageHandler)
						} else if (event.data.type === 'LOCAL_SYNC_ERROR') {
							console.error('[App] Final sync failed:', event.data.error)
							currentWorker.removeEventListener('message', messageHandler)
						}
					}

					// Add the message handler
					currentWorker.addEventListener('message', messageHandler)

					// Send the sync message
					currentWorker.postMessage({
						type: 'SYNC_TO_LOCAL',
						fileId: currentFileId,
						elements,
						files,
						appState: filteredAppState,
					})

					// Set a timeout to remove the handler after 500ms in case we don't get a response
					setTimeout(() => {
						currentWorker.removeEventListener('message', messageHandler)
					}, 500)
				} catch (error) {
					console.error('[App] Error during final sync on unmount:', error)
				}
			}
		}
	}, [])

	// Load data when fileId changes
	useEffect(() => {
		if (fileId) {
			setIsLoading(true)
			loadBoard()
		}
	}, [fileId, loadBoard])

	return {
		isLoading,
		loadBoard,
		saveOnUnmount,
	}
}
