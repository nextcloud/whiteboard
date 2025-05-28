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
import { useWhiteboardConfigStore } from './stores/useWhiteboardConfigStore'
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
import { useBoardDataManager } from './hooks/useBoardDataManager'

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
		resetInitialDataPromise,
		resetStore,
	} = useWhiteboardConfigStore(useShallow(state => ({
		setConfig: state.setConfig,
		zenModeEnabled: state.zenModeEnabled,
		gridModeEnabled: state.gridModeEnabled,
		initialDataPromise: state.initialDataPromise,
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

	// Use the board data manager hook
	const { saveOnUnmount, isLoading } = useBoardDataManager()

	useEffect(() => {
		resetInitialDataPromise()
		console.log('[App] Reset initialDataPromise on mount')

		// On unmount: Clean up all stores to prevent stale state
		return () => {
			// Save any pending changes before resetting stores
			saveOnUnmount()

			// Reset all stores
			console.log('[App] Resetting all stores on unmount')
			resetStore()
			resetExcalidrawAPI()

			// Terminate the worker
			terminateWorker()
		}
	}, [resetInitialDataPromise, resetStore, resetExcalidrawAPI, terminateWorker, saveOnUnmount])

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
