/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState, useRef } from 'react'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useSyncStore } from '../stores/useSyncStore'
import { db } from '../database/db'
// @ts-expect-error - Type definitions issue with @nextcloud/router
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import { initialDataState } from '../App'
import logger from '../logger'

export function useBoardDataManager() {
	const [isLoading, setIsLoading] = useState(true)
	const loadingTimeoutsRef = useRef<Set<NodeJS.Timeout>>(new Set())
	const currentFileIdRef = useRef<number | null>(null)

	const {
		fileId,
		resolveInitialData,
		resetInitialDataPromise,
	} = useWhiteboardConfigStore(useShallow(state => ({
		fileId: state.fileId,
		resolveInitialData: state.resolveInitialData,
		resetInitialDataPromise: state.resetInitialDataPromise,
	})))

	const fetchDataFromServer = useCallback(async (fileId: number) => {
		try {
			const jwt = await useJWTStore.getState().getJWT()
			if (!jwt) {
				logger.error('[BoardDataManager] Failed to get JWT token for server data fetch')
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
				logger.error(`[BoardDataManager] Server responded with status: ${response.status} when fetching data`)
				return null
			}

			const responseData = await response.json()
			if (!responseData || !responseData.data) {
				logger.error('[BoardDataManager] Invalid response data from server:', responseData)
				return null
			}

			return responseData.data
		} catch (error) {
			logger.error('[BoardDataManager] Error fetching data from server:', error)
			return null
		}
	}, [])

	// Cleanup function to cancel all pending timeouts
	const cancelPendingTimeouts = useCallback(() => {
		loadingTimeoutsRef.current.forEach(timeout => clearTimeout(timeout))
		loadingTimeoutsRef.current.clear()
	}, [])

	const loadBoard = useCallback(async () => {
		if (!fileId) {
			logger.warn('[BoardDataManager] No fileId provided, cannot load data')
			resolveInitialData(initialDataState)
			setIsLoading(false)
			return
		}

		// Store the current fileId to validate later
		currentFileIdRef.current = fileId

		try {
			const defaultSettings = {
				currentItemFontFamily: 3,
				currentItemStrokeWidth: 1,
				currentItemRoughness: 0,
			}

			const localData = await db.get(fileId)

			// Validate that we're still loading the same file
			if (currentFileIdRef.current !== fileId) {
				return
			}

			// ALWAYS fetch from server to get latest data
			const serverData = await fetchDataFromServer(fileId)

			// Validate that we're still loading the same file
			if (currentFileIdRef.current !== fileId) {
				return
			}

			let dataToUse = null

			if (serverData && serverData.elements && Array.isArray(serverData.elements)) {
				// Server has data
				if (localData && localData.elements && Array.isArray(localData.elements)) {
					// Both server and local have data - need to reconcile
					// Use Excalidraw's reconcile logic to merge them
					const { reconcileElements } = await import('../util')
					const { restoreElements } = await import('@excalidraw/excalidraw')

					const restoredServerElements = restoreElements(serverData.elements, null)
					const restoredLocalElements = restoreElements(localData.elements, null)

					// Reconcile server and local elements
					const reconciledElements = reconcileElements(restoredLocalElements, restoredServerElements, {})

					dataToUse = {
						elements: reconciledElements,
						files: { ...localData.files, ...serverData.files },
						appState: { ...localData.appState, ...serverData.appState },
					}

					// Save reconciled data to IndexedDB
					await db.put(
						fileId,
						reconciledElements,
						dataToUse.files || {},
						dataToUse.appState,
					)
				} else {
					// Only server has data
					dataToUse = serverData

					// Save server data to IndexedDB
					await db.put(
						fileId,
						serverData.elements,
						serverData.files || {},
						serverData.appState,
					)
				}
			} else if (localData && localData.elements) {
				// Only local has data
				dataToUse = localData
			} else {
				// No data from either source
				dataToUse = null
			}

			// Final validation before resolving data
			if (currentFileIdRef.current !== fileId) {
				return
			}

			// Use the reconciled/fetched data
			if (dataToUse && dataToUse.elements) {
				const elements = dataToUse.elements
				const finalAppState = { ...defaultSettings, ...(dataToUse.appState || {}) }
				const files = dataToUse.files || {}

				// Force a small delay to ensure the component is ready to receive the data
				const timeout = setTimeout(() => {
					// Validate one more time before resolving
					if (currentFileIdRef.current === fileId) {
						resolveInitialData({
							elements,
							appState: finalAppState,
							files,
							scrollToContent: true,
						})
						setIsLoading(false)
					}
					loadingTimeoutsRef.current.delete(timeout)
				}, 50)
				loadingTimeoutsRef.current.add(timeout)
			} else {
				// No valid data from either source, use defaults
				// Force a small delay to ensure the component is ready to receive the data
				const timeout = setTimeout(() => {
					// Validate one more time before resolving
					if (currentFileIdRef.current === fileId) {
						resolveInitialData(initialDataState)
						setIsLoading(false)
					}
					loadingTimeoutsRef.current.delete(timeout)
				}, 50)
				loadingTimeoutsRef.current.add(timeout)
			}
		} catch (error) {
			logger.error('[BoardDataManager] Error loading data:', error)
			// Force a small delay to ensure the component is ready to receive the data
			const timeout = setTimeout(() => {
				// Validate one more time before resolving
				if (currentFileIdRef.current === fileId) {
					resolveInitialData(initialDataState)
					setIsLoading(false)
				}
				loadingTimeoutsRef.current.delete(timeout)
			}, 50)
			loadingTimeoutsRef.current.add(timeout)
		}
	}, [fileId, resolveInitialData, fetchDataFromServer])

	const saveOnUnmount = useCallback(() => {
		const api = useExcalidrawStore.getState().excalidrawAPI
		const currentIsReadOnly = useWhiteboardConfigStore.getState().isReadOnly

		if (api && !currentIsReadOnly) {

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

					// Set up a one-time message handler to detect when sync is complete
					const messageHandler = (event: MessageEvent) => {
						if (event.data.type === 'LOCAL_SYNC_COMPLETE') {
							currentWorker.removeEventListener('message', messageHandler)
						} else if (event.data.type === 'LOCAL_SYNC_ERROR') {
							logger.error('[App] Final sync failed:', event.data.error)
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
					logger.error('[App] Error during final sync on unmount:', error)
				}
			}
		}
	}, [])

	// Load data when fileId changes
	useEffect(() => {
		if (fileId) {
			// Cancel any pending timeouts from previous loads
			cancelPendingTimeouts()

			// Reset the initialDataPromise to ensure clean state
			resetInitialDataPromise()

			// Clear any existing Excalidraw data
			const api = useExcalidrawStore.getState().excalidrawAPI
			if (api) {
				api.resetScene()
			}

			setIsLoading(true)
			loadBoard()
		}
	}, [fileId, loadBoard, cancelPendingTimeouts, resetInitialDataPromise])

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cancelPendingTimeouts()
		}
	}, [cancelPendingTimeouts])

	return {
		isLoading,
		loadBoard,
		saveOnUnmount,
	}
}
