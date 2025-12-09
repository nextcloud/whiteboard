/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { getCurrentUser } from '@nextcloud/auth'
import { Excalidraw as ExcalidrawComponent, useHandleLibrary } from '@nextcloud/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { LibraryItems } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from './stores/useWhiteboardConfigStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { useReadOnlyState } from './hooks/useReadOnlyState'
import { ExcalidrawMenu } from './components/ExcalidrawMenu'
import Embeddable from './components/Embeddable'
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
import logger from './utils/logger'
import { useRecording } from './hooks/useRecording'
import { RecordingOverlay } from './components/Recording'
import { usePresentation } from './hooks/usePresentation'
import { PresentationOverlay } from './components/Presentation'
import { useCollaborationStore } from './stores/useCollaborationStore'
import { useElementCreatorTracking } from './hooks/useElementCreatorTracking'
import { CreatorDisplay } from './components/CreatorDisplay'
import { useCreatorDisplayStore } from './stores/useCreatorDisplayStore'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { ElementCreatorInfo } from './types/whiteboard'
import { VersionPreviewBanner } from './components/VersionPreviewBanner'
import { useVersionPreview } from './hooks/useVersionPreview'
import { subscribe, unsubscribe } from '@nextcloud/event-bus'

const Excalidraw = memo(ExcalidrawComponent)

const MemoizedNetworkStatusIndicator = memo(NetworkStatusIndicator)
const MemoizedAuthErrorNotification = memo(AuthErrorNotification)
const MemoizedExcalidrawMenu = memo(ExcalidrawMenu)

export interface WhiteboardAppProps {
	fileId: number
	fileName: string
	isEmbedded: boolean
	publicSharingToken: string | null
	collabBackendUrl: string
	versionSource: string | null
	fileVersion: string | null
}

export default function App({
	fileId,
	isEmbedded,
	fileName,
	publicSharingToken,
	collabBackendUrl,
	versionSource,
	fileVersion,
}: WhiteboardAppProps) {
	const normalizedFileId = Number.isFinite(fileId) ? fileId : Number(fileId)
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
	const { fetchLibraryItems, updateLibraryItems, isLibraryLoaded, setIsLibraryLoaded } = useLibrary()
	useCollaboration()
	const { isReadOnly, refreshReadOnlyState } = useReadOnlyState()

	const {
		isVersionPreview,
		versionLabel,
		versionSourceLabel,
		exitVersionPreview,
		handleRestoreVersion,
		handleExternalRestore,
		isRestoringVersion,
	} = useVersionPreview({
		fileId: normalizedFileId,
		versionSource,
		fileVersion,
		excalidrawAPI,
		refreshReadOnlyState,
		isReadOnly,
	})

	if (!normalizedFileId && !isVersionPreview) {
		logger.warn('[App] Invalid fileId during initialization:', fileId)

		return <div className="App-error">Invalid whiteboard ID. Please try again.</div>
	}

	// Creator tracking
	const creatorDisplaySettings = useCreatorDisplayStore(state => state.settings)
	useElementCreatorTracking({ excalidrawAPI, enabled: true })

	// Expose followUser globally for recording agent access
	useEffect(() => {
		// Create a followUser function that accesses the collaboration store directly
		window.followUser = (userId: string) => {
			if (!excalidrawAPI) {
				console.warn('[Collaboration] Cannot follow user: Excalidraw API not available')
				return
			}

			const currentSocket = useCollaborationStore.getState().socket
			if (!currentSocket?.connected) {
				logger.warn('[Collaboration] Cannot follow user: Socket not connected')
				return
			}

			// Set the followed user ID in the collaboration store
			useCollaborationStore.setState({ followedUserId: userId })
			logger.info(`[Collaboration] Recording agent now following user: ${userId}`)

			// Debug: Log current collaboration store state
			const state = useCollaborationStore.getState()
			logger.debug('[Collaboration] Current collaboration store state:', {
				followedUserId: state.followedUserId,
				socketConnected: state.socket?.connected,
				status: state.status,
			})
		}
		return () => {
			delete window.followUser
		}
	}, [excalidrawAPI])

	const recordingState = useRecording({ fileId: normalizedFileId })
	const presentationState = usePresentation({ fileId: normalizedFileId })

	useHandleLibrary({
		excalidrawAPI,
	})

	useEffect(() => {
		const onRestoreRequested = (payload: any) => {
			const payloadFileId = Number(payload?.fileInfo?.id)
			const mimetype = payload?.fileInfo?.mimetype
			const fileName = payload?.fileInfo?.name ?? ''
			const source = payload?.version?.source ?? payload?.version?.url ?? null
			const versionId = payload?.version?.fileVersion ?? null

			const isWhiteboard = mimetype === 'application/vnd.excalidraw+json'
				|| (typeof fileName === 'string' && fileName.toLowerCase().endsWith('.whiteboard'))

			if (!payload || !isWhiteboard) {
				return
			}

			if (!Number.isFinite(payloadFileId) || payloadFileId !== normalizedFileId) {
				return
			}

			if (!source) {
				logger.error('[App] Missing version source for whiteboard restore request', { payload })
				return
			}

			if (payload && typeof payload === 'object') {
				payload.preventDefault = true
			}

			handleExternalRestore(source, versionId).catch(error => {
				logger.error('[App] Failed to handle whiteboard restore from sidebar', { error, source, versionId })
			})
		}

		subscribe('files_versions:restore:requested', onRestoreRequested)

		return () => {
			unsubscribe('files_versions:restore:requested', onRestoreRequested)
		}
	}, [handleExternalRestore, normalizedFileId])

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
	}, [normalizedFileId, excalidrawAPI, resetInitialDataPromise, saveOnUnmount])

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
				setIsLibraryLoaded(true)
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
		setConfig({
			fileId: normalizedFileId,
			fileName,
			publicSharingToken,
			isEmbedded,
			collabBackendUrl,
		})
	}, [setConfig, normalizedFileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl])

	// UI Initialization Effect
	useEffect(() => {
		updateLang()
		renderSmartPicker()
		renderAssistant()
	}, [updateLang, renderSmartPicker, renderAssistant])

	const onLibraryChange = useCallback(async (items: LibraryItems) => {
		if (!isLibraryLoaded) {
			// Skip updating library items on first load
			return
		}
		try {
			await updateLibraryItems(items)
		} catch (error) {
			logger.error('[App] Error syncing library items:', error)
		}
	}, [isLibraryLoaded])

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
		if (isVersionPreview) {
			return
		}
		if (!excalidrawAPI || !normalizedFileId || isLoading) return
		onChangeSync()
	}, [excalidrawAPI, normalizedFileId, isLoading, onChangeSync, isVersionPreview])

	const canvasActions = useMemo(() => {
		if (isVersionPreview) {
			return {
				changeViewBackgroundColor: false,
				clearCanvas: false,
				export: false,
				loadScene: false,
				saveAsImage: false,
				saveToActiveFile: false,
				toggleTheme: false,
			}
		}

		return {
			loadScene: false,
		}
	}, [isVersionPreview])

	const appClassName = useMemo(() => (
		isVersionPreview ? 'App App--version-preview' : 'App'
	), [isVersionPreview])

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

	const beforeElementCreated = (el: ExcalidrawElement) => {
		const user = getCurrentUser()
		if (!user) {
			return el
		}
		const creatorInfo: ElementCreatorInfo = {
			uid: user.uid,
			displayName: user.displayName || user.uid,
			createdAt: Date.now(),
		}
		if (!el.customData) {
			el.customData = {
				creator: creatorInfo,
				lastModifiedAt: Date.now(),
			}
		} else {
			el.customData.creator = creatorInfo
			el.customData.lastmodifiedAt = Date.now()
		}
		return el
	}

	return (
		<div className={appClassName} style={{ display: 'flex', flexDirection: 'column' }}>
			<div className="excalidraw-wrapper" style={{ flex: 1, height: '100%', position: 'relative' }}>
				{!isVersionPreview && <MemoizedNetworkStatusIndicator />}
				<MemoizedAuthErrorNotification />
				{!isVersionPreview && (
					<button
						className={`grid-toggle-button ${gridModeEnabled ? 'active' : ''}`}
						onClick={() => setGridModeEnabled(!gridModeEnabled)}
						aria-pressed={gridModeEnabled}
						title="Toggle grid mode"
					>
						<Icon path={mdiGrid} size={1} />
					</button>
				)}
				{isVersionPreview && (
					<VersionPreviewBanner
						versionLabel={versionLabel}
						sourceLabel={versionSourceLabel}
						onExit={exitVersionPreview}
						onRestore={handleRestoreVersion}
						isRestoring={isRestoringVersion}
					/>
				)}
				<Excalidraw
					validateEmbeddable={() => true}
					renderEmbeddable={Embeddable}
					beforeElementCreated={beforeElementCreated}
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
						canvasActions,
						...(isVersionPreview ? { tools: { image: false } } : {}),
					}}
					onLinkOpen={onLinkOpen}
					onLibraryChange={onLibraryChange}
					langCode={lang}
					libraryReturnUrl={libraryReturnUrl}
				>
					{!isVersionPreview && (
						<MemoizedExcalidrawMenu
							fileNameWithoutExtension={fileNameWithoutExtension}
							recordingState={recordingState}
							presentationState={presentationState}
						/>
					)}
				</Excalidraw>
				{!isVersionPreview && (
					<RecordingOverlay
						{...recordingState}
						otherRecordingUsers={recordingState.otherUsers}
						hasOtherRecordingUsers={recordingState.hasOtherRecordingUsers}
						resetError={recordingState.resetError}
						dismissSuccess={recordingState.dismissSuccess}
						dismissUnavailableInfo={recordingState.dismissUnavailableInfo}
					/>
				)}
				{!isVersionPreview && (
					<PresentationOverlay
						presentationState={presentationState}
					/>
				)}
				{!isVersionPreview && (
					<CreatorDisplay
						excalidrawAPI={excalidrawAPI}
						settings={creatorDisplaySettings}
					/>
				)}
			</div>
		</div>
	)
}
