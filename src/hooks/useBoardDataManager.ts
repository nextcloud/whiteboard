/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react'
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import { db } from '../database/db'
import { initialDataState } from '../constants/excalidraw'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useSyncStore } from '../stores/useSyncStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import logger from '../utils/logger'
import {
	extractSnapshotFromPersistedBoard,
	resolveBoardLoadState,
} from '../utils/persistedBoardData'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

export function useBoardDataManager() {
	const [isLoading, setIsLoading] = useState(true)
	const loadingTimeoutsRef = useRef<Set<NodeJS.Timeout>>(new Set())
	const currentFileIdRef = useRef<number | null>(null)

	const {
		fileId,
		resolveInitialData,
		resetInitialDataPromise,
		isVersionPreview,
		versionSource,
		fileVersion,
	} = useWhiteboardConfigStore(useShallow(state => ({
		fileId: state.fileId,
		resolveInitialData: state.resolveInitialData,
		resetInitialDataPromise: state.resetInitialDataPromise,
		isVersionPreview: state.isVersionPreview,
		versionSource: state.versionSource,
		fileVersion: state.fileVersion,
	})))

	const { setPersistedMetadata, resetPersistedMetadata } = useSyncStore(useShallow(state => ({
		setPersistedMetadata: state.setPersistedMetadata,
		resetPersistedMetadata: state.resetPersistedMetadata,
	})))

	const fetchDataFromServer = useCallback(async (currentFileId: number) => {
		try {
			const jwt = await useJWTStore.getState().getJWT()
			if (!jwt) {
				logger.error('[BoardDataManager] Failed to get JWT token for server data fetch')
				return null
			}

			const url = generateUrl(`apps/whiteboard/${currentFileId}`)
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

	const cancelPendingTimeouts = useCallback(() => {
		loadingTimeoutsRef.current.forEach(timeout => clearTimeout(timeout))
		loadingTimeoutsRef.current.clear()
	}, [])

	const loadBoard = useCallback(async () => {
		if (isVersionPreview) {
			try {
				if (!versionSource) {
					logger.warn('[BoardDataManager] Version preview requested without a version source', {
						fileVersion,
					})
					resolveInitialData(initialDataState)
					setIsLoading(false)
					return
				}

				const response = await fetch(versionSource, {
					method: 'GET',
					credentials: 'include',
					headers: {
						Accept: 'application/json',
					},
				})

				if (!response.ok) {
					logger.error('[BoardDataManager] Failed to fetch version content', {
						versionSource,
						status: response.status,
					})
					resolveInitialData(initialDataState)
					setIsLoading(false)
					return
				}

				const rawContent = await response.text()
				let parsedContent: any = null
				if (rawContent.trim() !== '') {
					try {
						parsedContent = JSON.parse(rawContent)
					} catch (error) {
						logger.error('[BoardDataManager] Failed to parse version content', {
							error,
							versionSource,
						})
					}
				}

				if (!parsedContent) {
					logger.warn('[BoardDataManager] Version content missing elements array, falling back to defaults', {
						versionSource,
					})
					resolveInitialData(initialDataState)
					setIsLoading(false)
					return
				}

				const versionSnapshot = extractSnapshotFromPersistedBoard(parsedContent)
				const sanitizedAppState = sanitizeAppStateForSync(versionSnapshot.appState)
				const finalAppState = {
					...initialDataState.appState,
					...sanitizedAppState,
				}

				resolveInitialData({
					elements: versionSnapshot.elements,
					files: versionSnapshot.files || {},
					appState: finalAppState,
					scrollToContent: versionSnapshot.scrollToContent,
				})
				setIsLoading(false)
			} catch (error) {
				logger.error('[BoardDataManager] Error loading version content', error)
				resolveInitialData(initialDataState)
				setIsLoading(false)
			}
			return
		}

		if (!fileId) {
			logger.warn('[BoardDataManager] No fileId provided, cannot load data')
			resetPersistedMetadata()
			resolveInitialData(initialDataState)
			setIsLoading(false)
			return
		}

		currentFileIdRef.current = fileId

		try {
			const defaultSettings = {
				currentItemFontFamily: 3,
				currentItemStrokeWidth: 1,
				currentItemRoughness: 0,
			}

			const localData = await db.get(fileId)
			if (currentFileIdRef.current !== fileId) {
				return
			}

			const serverData = await fetchDataFromServer(fileId)
			if (currentFileIdRef.current !== fileId) {
				return
			}

			const boardState = resolveBoardLoadState({
				localBoard: localData,
				serverBoard: serverData,
			})

			if (!boardState) {
				resetPersistedMetadata()
				const timeout = setTimeout(() => {
					if (currentFileIdRef.current === fileId) {
						resolveInitialData(initialDataState)
						setIsLoading(false)
					}
					loadingTimeoutsRef.current.delete(timeout)
				}, 50)
				loadingTimeoutsRef.current.add(timeout)
				return
			}

			await db.put(
				fileId,
				boardState.snapshot.elements,
				boardState.snapshot.files || {},
				boardState.snapshot.appState,
				{
					scrollToContent: boardState.snapshot.scrollToContent,
					hasPendingLocalChanges: boardState.hasPendingLocalChanges,
					lastSyncedHash: boardState.lastSyncedHash,
					persistedRev: boardState.meta.persistedRev,
					lastServerUpdatedAt: boardState.meta.updatedAt,
					lastServerUpdatedBy: boardState.meta.updatedBy,
				},
			)

			setPersistedMetadata(boardState.meta)

			const sanitizedAppState = sanitizeAppStateForSync(boardState.snapshot.appState)
			const finalAppState = { ...defaultSettings, ...sanitizedAppState }
			const timeout = setTimeout(() => {
				if (currentFileIdRef.current === fileId) {
					resolveInitialData({
						elements: boardState.snapshot.elements,
						appState: finalAppState,
						files: boardState.snapshot.files || {},
						scrollToContent: boardState.snapshot.scrollToContent,
					})
					setIsLoading(false)
				}
				loadingTimeoutsRef.current.delete(timeout)
			}, 50)
			loadingTimeoutsRef.current.add(timeout)
		} catch (error) {
			logger.error('[BoardDataManager] Error loading data:', error)
			const timeout = setTimeout(() => {
				if (currentFileIdRef.current === fileId) {
					resetPersistedMetadata()
					resolveInitialData(initialDataState)
					setIsLoading(false)
				}
				loadingTimeoutsRef.current.delete(timeout)
			}, 50)
			loadingTimeoutsRef.current.add(timeout)
		}
	}, [
		fileId,
		fileVersion,
		fetchDataFromServer,
		isVersionPreview,
		resetPersistedMetadata,
		resetInitialDataPromise,
		resolveInitialData,
		setPersistedMetadata,
		versionSource,
	])

	const saveOnUnmount = useCallback(() => {
		if (useWhiteboardConfigStore.getState().isVersionPreview) {
			return
		}

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
					const filteredAppState = sanitizeAppStateForSync(appState)

					const messageHandler = (event: MessageEvent) => {
						if (event.data.type === 'LOCAL_SYNC_COMPLETE') {
							currentWorker.removeEventListener('message', messageHandler)
						} else if (event.data.type === 'LOCAL_SYNC_ERROR') {
							logger.error('[App] Final sync failed:', event.data.error)
							currentWorker.removeEventListener('message', messageHandler)
						}
					}

					currentWorker.addEventListener('message', messageHandler)
					currentWorker.postMessage({
						type: 'SYNC_TO_LOCAL',
						fileId: currentFileId,
						elements,
						files,
						appState: filteredAppState,
						scrollToContent: typeof appState.scrollToContent === 'boolean'
							? appState.scrollToContent
							: true,
					})

					setTimeout(() => {
						currentWorker.removeEventListener('message', messageHandler)
					}, 500)
				} catch (error) {
					logger.error('[App] Error during final sync on unmount:', error)
				}
			}
		}
	}, [])

	useEffect(() => {
		const shouldLoad = (
			(isVersionPreview && !!versionSource)
			|| (!isVersionPreview && !!fileId)
		)

		if (shouldLoad) {
			cancelPendingTimeouts()
			resetInitialDataPromise()

			const api = useExcalidrawStore.getState().excalidrawAPI
			if (api) {
				api.resetScene()
			}

			setIsLoading(true)
			loadBoard()
		}
	}, [fileId, fileVersion, isVersionPreview, versionSource, loadBoard, cancelPendingTimeouts, resetInitialDataPromise])

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
