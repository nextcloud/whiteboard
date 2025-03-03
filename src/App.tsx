/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { Excalidraw as ExcalidrawComponent, useHandleLibrary } from '@excalidraw/excalidraw'
import './App.scss'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardStore } from './stores/useWhiteboardStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { useReadOnlyState } from './hooks/useReadOnlyState'
import { ExcalidrawMenu } from './components/ExcalidrawMenu'
import Embeddable from './Embeddable'
import { useLangStore } from './stores/useLangStore'
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator'
import { useSync } from './hooks/useSync'
import { useSyncStore } from './stores/useSyncStore'
import { useShallow } from 'zustand/react/shallow'

import { db } from './database/db'

const Excalidraw = memo(ExcalidrawComponent)

export const initialDataState: ExcalidrawInitialDataState = {
	elements: [],
	appState: {
		currentItemFontFamily: 3,
		currentItemStrokeWidth: 1,
		currentItemRoughness: 0,
	},
	files: {},
}

const MemoizedNetworkStatusIndicator = memo(NetworkStatusIndicator)
const MemoizedExcalidrawMenu = memo(ExcalidrawMenu)

interface WhiteboardAppProps {
	fileId: number
	fileName: string
	isEmbedded: boolean
	publicSharingToken: string | null
	collabBackendUrl: string
}

export default function App({
	fileId,
	isEmbedded,
	fileName,
	publicSharingToken,
	collabBackendUrl,
}: WhiteboardAppProps) {
	if (!fileId) {
		console.warn('[App] Invalid fileId during initialization:', fileId)

		return <div className="App-error">Invalid whiteboard ID. Please try again.</div>
	}

	const fileNameWithoutExtension = useMemo(() => fileName.split('.').slice(0, -1).join('.'), [fileName])

	const { excalidrawAPI, setExcalidrawAPI, resetExcalidrawAPI } = useExcalidrawStore(useShallow(state => ({
		excalidrawAPI: state.excalidrawAPI,
		setExcalidrawAPI: state.setExcalidrawAPI,
		resetExcalidrawAPI: state.resetExcalidrawAPI,
	})))

	const {
		setConfig,
		zenModeEnabled,
		gridModeEnabled,
		initialDataPromise,
		resolveInitialData,
		isInitializing,
		setIsInitializing,
		resetInitialDataPromise,
		resetStore,
	} = useWhiteboardStore(useShallow(state => ({
		setConfig: state.setConfig,
		zenModeEnabled: state.zenModeEnabled,
		gridModeEnabled: state.gridModeEnabled,
		initialDataPromise: state.initialDataPromise,
		resolveInitialData: state.resolveInitialData,
		isInitializing: state.isInitializing,
		setIsInitializing: state.setIsInitializing,
		resetInitialDataPromise: state.resetInitialDataPromise,
		resetStore: state.resetStore,
	})))

	const { lang, updateLang } = useLangStore(useShallow(state => ({
		lang: state.lang,
		updateLang: state.updateLang,
	})))

	const { terminateWorker } = useSyncStore(useShallow(state => ({
		terminateWorker: state.terminateWorker,
	})))

	const { theme } = useThemeHandling()
	const { renderSmartPicker } = useSmartPicker()
	const { onChange: onChangeSync, onPointerUpdate } = useSync()
	useCollaboration()
	const { isReadOnly } = useReadOnlyState()

	useHandleLibrary({
		excalidrawAPI,
	})

	useEffect(() => {
		resetInitialDataPromise()

		console.log('[App] Reset initialDataPromise on mount')

		// On unmount: Clean up all stores to prevent stale state
		return () => {
			// Save any pending changes before resetting stores
			const api = useExcalidrawStore.getState().excalidrawAPI
			const currentIsReadOnly = useWhiteboardStore.getState().isReadOnly

			if (api && !currentIsReadOnly) {
				console.log('[App] Saving final state on unmount')
				// We can't use the hook's doSyncToLocal directly, so we'll replicate its logic
				const currentFileId = useWhiteboardStore.getState().fileId
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

			// Reset all stores
			console.log('[App] Resetting all stores on unmount')
			resetStore()
			resetExcalidrawAPI()

			// Terminate the worker
			terminateWorker()
		}
	}, [resetInitialDataPromise, resetStore, resetExcalidrawAPI, terminateWorker]) // Include the useShallow dependencies

	useLayoutEffect(() => {
		setConfig({ fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl })
		console.log('[App] Configuration set')
	}, [setConfig, fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl])

	// UI Initialization Effect
	useEffect(() => {
		console.log('[App] Initializing UI components')
		updateLang()
		renderSmartPicker()
	}, [updateLang, renderSmartPicker])

	// Data Loading Effect
	useEffect(() => {
		const loadInitialData = async () => {
			console.log('[App] Loading initial data for fileId:', fileId)
			try {
				const defaultSettings = {
					currentItemFontFamily: 3,
					currentItemStrokeWidth: 1,
					currentItemRoughness: 0,
				}

				// Get local data from IndexedDB
				const localData = await db.get(fileId)

				if (localData) {
					console.log('[App] Local data retrieved:', {
						elementCount: localData.elements?.length || 0,
						savedAt: localData.savedAt ? new Date(localData.savedAt).toISOString() : 'unknown',
						fileId: localData.id,
					})
				} else {
					console.log('[App] No local data found for fileId:', fileId)
				}

				// If we have local data with elements, use it
				if (localData && localData.elements && Array.isArray(localData.elements)) {
					// Even if there are no elements, we should still use the local data
					// This handles the case where the user has deleted all elements
					const elements = localData.elements
					const finalAppState = { ...defaultSettings, ...(localData.appState || {}) }
					const files = localData.files || {}

					console.log(`[App] Loading data from local storage: ${elements.length} elements, ${Object.keys(files).length} files`)

					// Force a small delay to ensure the component is ready to receive the data
					setTimeout(() => {
						resolveInitialData({
							elements,
							appState: finalAppState,
							files,
							scrollToContent: true,
						})
						console.log('[App] Loaded data from local storage with merged settings')
					}, 50)
				} else {
					console.log('[App] No valid elements found in local data, using defaults')
					// Force a small delay to ensure the component is ready to receive the data
					setTimeout(() => {
						resolveInitialData(initialDataState)
					}, 50)
				}
			} catch (error) {
				console.error('[App] Error loading data:', error)
				// Force a small delay to ensure the component is ready to receive the data
				setTimeout(() => {
					resolveInitialData(initialDataState)
				}, 50)
			} finally {
				// Delay setting isInitializing to false to ensure data is loaded
				setTimeout(() => {
					setIsInitializing(false)
				}, 100)
			}
		}

		// Only load data if we have a valid fileId
		if (fileId) {
			loadInitialData()
		} else {
			console.warn('[App] No fileId provided, cannot load data')
			resolveInitialData(initialDataState)
			setIsInitializing(false)
		}
	}, [fileId, resolveInitialData, setIsInitializing])

	const onLinkOpen = useCallback((element: any, event: any) => {
		const link = element.link
		const { nativeEvent } = event.detail
		const isNewTab = nativeEvent.ctrlKey || nativeEvent.metaKey
		const isNewWindow = nativeEvent.shiftKey
		const isInternalLink = link.startsWith('/') || link.includes(window.location.origin)

		if (isInternalLink && !isNewTab && !isNewWindow) {
			event.preventDefault()
		}
	}, [])

	const handleOnChange = useCallback(() => {
		if (!excalidrawAPI || !fileId || isInitializing) return
		onChangeSync()
	}, [excalidrawAPI, fileId, isInitializing, onChangeSync])

	if (isInitializing) {
		return (
			<div className="App" style={{ display: 'flex', flexDirection: 'column' }}>
				<div className="App-loading" style={{
					flex: 1,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}>
					Loading whiteboard...
				</div>
			</div>
		)
	}

	return (
		<div className="App" style={{ display: 'flex', flexDirection: 'column' }}>
			<div className="excalidraw-wrapper" style={{ flex: 1, height: '100%', position: 'relative' }}>
				<MemoizedNetworkStatusIndicator />
				<Excalidraw
					validateEmbeddable={() => true}
					renderEmbeddable={Embeddable}
					excalidrawAPI={setExcalidrawAPI}
					initialData={initialDataPromise}
					onPointerUpdate={onPointerUpdate}
					onChange={handleOnChange}
					viewModeEnabled={isReadOnly}
					zenModeEnabled={zenModeEnabled}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					name={fileNameWithoutExtension}
					UIOptions={{
						canvasActions: {
							loadScene: false,
						},
					}}
					onLinkOpen={onLinkOpen}
					langCode={lang}
				>
					<MemoizedExcalidrawMenu
						fileNameWithoutExtension={fileNameWithoutExtension}
					/>
				</Excalidraw>
			</div>
		</div>
	)
}
