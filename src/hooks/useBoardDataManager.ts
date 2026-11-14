/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LibraryRef } from '../stores/useWhiteboardConfigStore'
import type { BoardSync } from '../sync/boardSync.ts'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { initialDataState } from '../constants/excalidraw'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { getBoardSync } from '../sync/boardSync.ts'
import { boardAccount, createBoardSync, showBoard } from '../sync/createBoardSync.ts'
import logger from '../utils/logger'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

// Counts the boards and versions opened in this page, across React roots; an answer for an earlier one is dropped
let openings = 0

const defaultSettings = {
	currentItemFontFamily: 3,
	currentItemStrokeWidthKey: 'thin' as const,
	currentItemRoughness: 0,
}

export function useBoardDataManager() {
	const [isLoading, setIsLoading] = useState(true)
	const loadingTimeoutsRef = useRef<Set<NodeJS.Timeout>>(new Set())
	const openedRef = useRef<BoardSync | null>(null)

	const {
		fileId,
		resolveInitialData,
		resetInitialDataPromise,
		setLibraryRef,
		isVersionPreview,
		versionSource,
		fileVersion,
	} = useWhiteboardConfigStore(useShallow((state) => ({
		fileId: state.fileId,
		resolveInitialData: state.resolveInitialData,
		resetInitialDataPromise: state.resetInitialDataPromise,
		setLibraryRef: state.setLibraryRef,
		isVersionPreview: state.isVersionPreview,
		versionSource: state.versionSource,
		fileVersion: state.fileVersion,
	})))

	const cancelPendingTimeouts = useCallback(() => {
		loadingTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
		loadingTimeoutsRef.current.clear()
	}, [])

	const loadBoard = useCallback(async () => {
		// The page may show another board, or another version, by the time an answer arrives
		const opening = ++openings
		const isStillShown = () => {
			const shown = useWhiteboardConfigStore.getState()
			return opening === openings && shown.fileId === fileId && shown.isVersionPreview === isVersionPreview && shown.versionSource === versionSource
		}
		// Only for the version still shown: another may have opened while this one loaded
		const finish = (data: Parameters<typeof resolveInitialData>[0]) => {
			if (isStillShown()) {
				resolveInitialData(data)
				setIsLoading(false)
			}
		}
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
					finish(initialDataState)
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

				if (!parsedContent || !Array.isArray(parsedContent.elements)) {
					logger.warn('[BoardDataManager] Version content missing elements array, falling back to defaults', {
						versionSource,
					})
					finish(initialDataState)
					return
				}

				const sanitizedAppState = sanitizeAppStateForSync(parsedContent.appState)
				const finalAppState = {
					...initialDataState.appState,
					...sanitizedAppState,
				}

				finish({
					elements: parsedContent.elements,
					files: parsedContent.files || {},
					appState: finalAppState,
					scrollToContent: parsedContent.scrollToContent ?? true,
				})
			} catch (error) {
				logger.error('[BoardDataManager] Error loading version content', error)
				finish(initialDataState)
			}
			return
		}

		if (!fileId) {
			logger.warn('[BoardDataManager] No fileId provided, cannot load data')
			resolveInitialData(initialDataState)
			setIsLoading(false)
			return
		}

		const sync = createBoardSync(fileId, boardAccount())
		openedRef.current = sync
		showBoard(sync)

		const data = await sync.open()
		if (!isStillShown() || getBoardSync() !== sync) {
			return
		}

		setLibraryRef((data?.libraryRef as LibraryRef | undefined) ?? null)
		// A short delay, so the component is ready to receive the data
		const timeout = setTimeout(() => {
			if (isStillShown()) {
				resolveInitialData(data
					? {
							elements: data.elements,
							appState: { ...defaultSettings, ...sanitizeAppStateForSync(data.appState) },
							files: data.files || {},
							scrollToContent: data.scrollToContent ?? true,
						}
					: initialDataState)
				setIsLoading(false)
			}
			loadingTimeoutsRef.current.delete(timeout)
		}, 50)
		loadingTimeoutsRef.current.add(timeout)
	}, [fileId, resolveInitialData, setLibraryRef, isVersionPreview, versionSource, fileVersion])

	// Load data when fileId changes
	useEffect(() => {
		const shouldLoad = (
			(isVersionPreview && !!versionSource)
			|| (!isVersionPreview && !!fileId)
		)

		if (shouldLoad) {
			// Cancel any pending timeouts from previous loads
			cancelPendingTimeouts()

			// Reset the initialDataPromise to ensure clean state
			resetInitialDataPromise()

			// The board shown so far closes first, so it still sends what it has not saved
			showBoard(null)
			const api = useExcalidrawStore.getState().excalidrawAPI
			if (api) {
				api.resetScene()
			}

			setIsLoading(true)
			loadBoard()
		}
	}, [fileId, fileVersion, isVersionPreview, versionSource, loadBoard, cancelPendingTimeouts, resetInitialDataPromise])

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cancelPendingTimeouts()
			// Only its own board: another one may already be open in this page
			if (getBoardSync() === openedRef.current) {
				showBoard(null)
			}
		}
	}, [cancelPendingTimeouts])

	return {
		isLoading,
		loadBoard,
	}
}
