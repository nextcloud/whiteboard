/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { Excalidraw as ExcalidrawComponent, useHandleLibrary } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './App.scss'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from './stores/useWhiteboardConfigStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { useReadOnlyState } from './hooks/useReadOnlyState'
import { ExcalidrawMenu } from './components/ExcalidrawMenu'
import Embeddable from './Embeddable'
import { useLangStore } from './stores/useLangStore'
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator'
import { AuthErrorNotification } from './components/AuthErrorNotification'
import { useSync } from './hooks/useSync'
import { useSyncStore } from './stores/useSyncStore'
import { useLibrary } from './hooks/useLibrary'
import { useShallow } from 'zustand/react/shallow'
import { useBoardDataManager } from './hooks/useBoardDataManager'
import { Icon } from '@mdi/react'
import { mdiGrid } from '@mdi/js'
import { useAssistant } from './hooks/useAssistant'
import logger from './logger'

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
const MemoizedAuthErrorNotification = memo(AuthErrorNotification)
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
		logger.warn('[App] Invalid fileId during initialization:', fileId)

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
		resetInitialDataPromise,
		resetStore,
		setGridModeEnabled,
	} = useWhiteboardConfigStore(useShallow(state => ({
		setConfig: state.setConfig,
		zenModeEnabled: state.zenModeEnabled,
		gridModeEnabled: state.gridModeEnabled,
		initialDataPromise: state.initialDataPromise,
		resetInitialDataPromise: state.resetInitialDataPromise,
		resetStore: state.resetStore,
		setGridModeEnabled: state.setGridModeEnabled,
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
	const { renderAssistant } = useAssistant()
	const { onChange: onChangeSync, onPointerUpdate } = useSync()
	const { fetchLibraryItems, updateLibraryItems } = useLibrary()
	useCollaboration()
	const { isReadOnly } = useReadOnlyState()

	useHandleLibrary({
		excalidrawAPI,
	})

	// Use the board data manager hook
	const { saveOnUnmount, isLoading } = useBoardDataManager()

	// Effect to handle fileId changes - cleanup previous board data
	useEffect(() => {
		// Clear any existing Excalidraw data when fileId changes
		if (excalidrawAPI) {
			excalidrawAPI.resetScene()
		}

		// Reset the initialDataPromise to ensure clean state
		resetInitialDataPromise()

		return () => {
			// Save current board data before switching
			if (excalidrawAPI) {
				saveOnUnmount()
			}
		}
	}, [fileId, excalidrawAPI, resetInitialDataPromise, saveOnUnmount])

	useEffect(() => {
		resetInitialDataPromise()

		// Fetch library items from the API
		window.name = fileName
		const fetchLibInterval = setInterval(async () => {
			const api = useExcalidrawStore.getState().excalidrawAPI
			if (!api) {
				logger.warn('[App] Excalidraw API not available, cannot update library')
				return
			}
			clearInterval(fetchLibInterval)
			try {
				const libraryItems = await fetchLibraryItems()
				await api.updateLibrary({
					libraryItems: libraryItems || [],
				})
			} catch (error) {
				logger.error('[App] Error updating library items:', error)
			}
		}, 1000)

		// On unmount: Clean up all stores to prevent stale state
		return () => {
			// Save any pending changes before resetting stores
			saveOnUnmount()

			// Reset all stores
			resetStore()
			resetExcalidrawAPI()

			// Terminate the worker
			terminateWorker()
		}
	}, [resetInitialDataPromise, resetStore, resetExcalidrawAPI, terminateWorker, saveOnUnmount])

	useLayoutEffect(() => {
		setConfig({ fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl })
	}, [setConfig, fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl])

	// UI Initialization Effect
	useEffect(() => {
		updateLang()
		renderSmartPicker()
		renderAssistant()
	}, [updateLang, renderSmartPicker, renderAssistant])

	const onLibraryChange = useCallback(async (items: LibraryItems) => {
		try {
			await updateLibraryItems(items)
		} catch (error) {
			logger.error('[App] Error syncing library items:', error)
		}
	}, [])

	const libraryReturnUrl = encodeURIComponent(window.location.href)

	// Data loading is now handled by useBoardDataManager

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
		if (!excalidrawAPI || !fileId || isLoading) return
		onChangeSync()
	}, [excalidrawAPI, fileId, isLoading, onChangeSync])

	if (isLoading) {
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
				<MemoizedAuthErrorNotification />
				<button
					className={`grid-toggle-button ${gridModeEnabled ? 'active' : ''}`}
					onClick={() => setGridModeEnabled(!gridModeEnabled)}
					aria-pressed={gridModeEnabled}
					title="Toggle grid mode"
				>
					<Icon path={mdiGrid} size={1} />
				</button>
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
					onLibraryChange={onLibraryChange}
					langCode={lang}
					libraryReturnUrl={libraryReturnUrl}
				>
					<MemoizedExcalidrawMenu
						fileNameWithoutExtension={fileNameWithoutExtension}
					/>
				</Excalidraw>
			</div>
		</div>
	)
}
