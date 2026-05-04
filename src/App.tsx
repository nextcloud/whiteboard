/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getCurrentUser } from '@nextcloud/auth'
import { translate as t, translatePlural as n } from '@nextcloud/l10n'
import { loadState } from '@nextcloud/initial-state'
import { Excalidraw as ExcalidrawComponent, useHandleLibrary, Sidebar, isElementLink } from '@nextcloud/excalidraw'
import '@nextcloud/excalidraw/index.css'
import type { ExcalidrawImperativeAPI, LibraryItems } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from './stores/useWhiteboardConfigStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { useTableInsertion } from './hooks/useTableInsertion'
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
import { useAssistant } from './hooks/useAssistant'
import logger from './utils/logger'
import { useRecording } from './hooks/useRecording'
import { RecordingOverlay } from './components/Recording'
import { usePresentation } from './hooks/usePresentation'
import { PresentationOverlay } from './components/Presentation'
import { useTimer } from './hooks/useTimer'
import { TimerOverlay } from './components/Timer'
import { useCollaborationStore } from './stores/useCollaborationStore'
import { useElementCreatorTracking } from './hooks/useElementCreatorTracking'
import { useFollowedUser } from './hooks/useFollowedUser'
import { CreatorDisplay } from './components/CreatorDisplay'
import { useCreatorDisplayStore } from './stores/useCreatorDisplayStore'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { ElementCreatorInfo } from './types/whiteboard'
import { VersionPreviewBanner } from './components/VersionPreviewBanner'
import { useVersionPreview } from './hooks/useVersionPreview'
import { subscribe, unsubscribe } from '@nextcloud/event-bus'
import { useComment } from './hooks/useComment'
import { CommentSidebar } from './components/CommentSidebar'
import { useEmojiPicker } from './hooks/useEmojiPicker'
import { VotingSidebar } from './components/VotingSidebar'
import { useVoting } from './hooks/useVoting'
import { useContextMenuFilter } from './hooks/useContextMenuFilter'
import { useDisableExternalLibraries } from './hooks/useDisableExternalLibraries'
import { showError, showSuccess } from '@nextcloud/dialogs'

const Excalidraw = memo(ExcalidrawComponent)

const MemoizedNetworkStatusIndicator = memo(NetworkStatusIndicator)
const MemoizedAuthErrorNotification = memo(AuthErrorNotification)
const MemoizedExcalidrawMenu = memo(ExcalidrawMenu)

type LoadLibraryForApi = (api: ExcalidrawImperativeAPI) => void
type LibraryTemplateDialogSource = 'library' | 'selection'
const LIBRARY_TEMPLATE_LOADED_STORAGE_KEY = 'whiteboard.libraryTemplateLoaded'

function formatLibraryItemCount(count: number): string {
	return n('whiteboard', '%n library item', '%n library items', count)
}

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
	const maxImageSizeMb = useMemo(() => {
		const rawValue = Number(loadState('whiteboard', 'maxFileSize', 10))
		if (!Number.isFinite(rawValue) || rawValue <= 0) {
			return null
		}
		return rawValue
	}, [])
	const maxImageSizeBytes = useMemo(() => (
		maxImageSizeMb ? maxImageSizeMb * 1024 * 1024 : null
	), [maxImageSizeMb])

	const { excalidrawAPI, setExcalidrawAPI, resetExcalidrawAPI } = useExcalidrawStore(useShallow(state => ({
		excalidrawAPI: state.excalidrawAPI,
		setExcalidrawAPI: state.setExcalidrawAPI,
		resetExcalidrawAPI: state.resetExcalidrawAPI,
	})))
	const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
	const loadLibraryForApiRef = useRef<LoadLibraryForApi>(() => {})
	const handleExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI | null) => {
		if (api) {
			excalidrawAPIRef.current = api
			setExcalidrawAPI(api)
			loadLibraryForApiRef.current(api)
			return
		}
		excalidrawAPIRef.current = null
		resetExcalidrawAPI()
	}, [resetExcalidrawAPI, setExcalidrawAPI])

	const {
		setConfig,
		gridModeEnabled,
		initialDataPromise,
		resetInitialDataPromise,
		resetStore,
		setGridModeEnabled,
	} = useWhiteboardConfigStore(useShallow(state => ({
		setConfig: state.setConfig,
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
	const { renderTable } = useTableInsertion()
	const { renderAssistant } = useAssistant()
	const { renderEmojiPicker } = useEmojiPicker()
	const { onChange: onChangeSync, onPointerUpdate } = useSync()
	const {
		fetchLibraryItems,
		mergeInitialLibraryItems,
		updateLibraryItems,
		saveLibraryTemplate,
		isLibraryLoaded,
		setIsLibraryLoaded,
	} = useLibrary()
	const [libraryTemplateDialogItems, setLibraryTemplateDialogItems] = useState<LibraryItems | null>(null)
	const [libraryTemplateDialogSource, setLibraryTemplateDialogSource] = useState<LibraryTemplateDialogSource>('library')
	const [libraryTemplateName, setLibraryTemplateName] = useState('')
	const [libraryTemplateError, setLibraryTemplateError] = useState<string | null>(null)
	const [isSavingLibraryTemplate, setIsSavingLibraryTemplate] = useState(false)
	const libraryTemplateNameInputRef = useRef<HTMLInputElement | null>(null)
	const notifiedLibraryTemplateFileIdRef = useRef<number | null>(null)
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

		return <div className="App-error">{t('whiteboard', 'Invalid whiteboard ID. Please try again.')}</div>
	}

	// Creator tracking
	const creatorDisplaySettings = useCreatorDisplayStore(state => state.settings)
	useElementCreatorTracking({ excalidrawAPI, enabled: true })
	useFollowedUser({ excalidrawAPI, fileId: normalizedFileId })

	useContextMenuFilter(excalidrawAPI)
	useDisableExternalLibraries()

	useEffect(() => {
		const handleVideoError = (e: Event) => {
			const target = e.target as HTMLElement
			if (target?.tagName === 'VIDEO') {
				logger.error('[App] Caught video embed error:', e)
				e.stopPropagation()
				e.stopImmediatePropagation()
				e.preventDefault()
			}
		}

		window.addEventListener('error', handleVideoError, true)

		return () => {
			window.removeEventListener('error', handleVideoError, true)
		}
	}, [])

	const recordingState = useRecording({ fileId: normalizedFileId })
	const presentationState = usePresentation({ fileId: normalizedFileId })
	const timerState = useTimer({ fileId: normalizedFileId })
	const [isTimerPinned, setIsTimerPinned] = useState(false)
	const [isTimerDismissed, setIsTimerDismissed] = useState(false)
	const isTimerActive = timerState.status !== 'idle'
	const isTimerVisible = isTimerPinned || (isTimerActive && !isTimerDismissed)

	useEffect(() => {
		if (!isTimerActive) {
			setIsTimerDismissed(false)
		}
	}, [isTimerActive])

	const handleToggleTimer = useCallback(() => {
		if (isTimerVisible) {
			setIsTimerPinned(false)
			if (isTimerActive) {
				setIsTimerDismissed(true)
			}
			return
		}

		setIsTimerDismissed(false)
		if (!isTimerActive) {
			setIsTimerPinned(true)
		}
	}, [isTimerVisible, isTimerActive])

	// Voting
	const { startVoting, vote, endVoting } = useVoting()
	const votings = useCollaborationStore(state => state.votings)

	useHandleLibrary({
		excalidrawAPI,
	})

	useEffect(() => {
		if (!excalidrawAPI) return

		const preventEmbedWheelPropagation = () => {
			document.querySelectorAll('.excalidraw__embeddable-container').forEach(container => {
				if (!container.dataset.wheelPrevented) {
					container.addEventListener('wheel', (e) => e.stopPropagation())
					container.dataset.wheelPrevented = 'true'
				}
			})
		}

		preventEmbedWheelPropagation()

		const observer = new MutationObserver(preventEmbedWheelPropagation)
		const wrapper = document.querySelector('.excalidraw')

		if (wrapper) {
			observer.observe(wrapper, { childList: true })
		}

		return () => observer.disconnect()
	}, [excalidrawAPI])

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
	const { saveOnUnmount, isLoading, getInitialLibraryItems, getInitialLibraryItemsPresent } = useBoardDataManager()

	loadLibraryForApiRef.current = (api: ExcalidrawImperativeAPI) => {
		if (isLoading) {
			return
		}

		window.name = fileName
		const loadLibraryItems = async () => {
			try {
				const initialLibraryItems = getInitialLibraryItems()
				const hasInitialLibraryItems = getInitialLibraryItemsPresent() && initialLibraryItems.length > 0
				const libraryItems = await fetchLibraryItems()
				const mergedLibraryItems = mergeInitialLibraryItems(
					libraryItems || [],
					initialLibraryItems,
					hasInitialLibraryItems,
				)
				await api.updateLibrary({
					libraryItems: mergedLibraryItems,
					merge: false,
				})
				if (hasInitialLibraryItems && !isVersionPreview) {
					const notificationKey = `${LIBRARY_TEMPLATE_LOADED_STORAGE_KEY}.${normalizedFileId}`
					let alreadyNotified = notifiedLibraryTemplateFileIdRef.current === normalizedFileId
					try {
						alreadyNotified = alreadyNotified || window.localStorage.getItem(notificationKey) === '1'
					} catch {
						// Ignore blocked storage. The notification is best-effort UI polish.
					}
					if (!alreadyNotified) {
						api.toggleSidebar({ name: 'default', tab: 'library', force: true })
						showSuccess(t('whiteboard', 'Library template loaded. {items} were added to the Library sidebar.', {
							items: formatLibraryItemCount(initialLibraryItems.length),
						}))
						notifiedLibraryTemplateFileIdRef.current = normalizedFileId
						try {
							window.localStorage.setItem(notificationKey, '1')
						} catch {
							// Ignore blocked storage. The in-memory guard still prevents duplicate toasts this load.
						}
					}
				}
				setIsLibraryLoaded(true)
			} catch (error) {
				logger.error('[App] Error updating library items:', error)
			}
		}
		loadLibraryItems()
	}

	useEffect(() => {
		if (!excalidrawAPI || isLoading || isLibraryLoaded) {
			return
		}
		loadLibraryForApiRef.current(excalidrawAPI)
	}, [excalidrawAPI, isLoading, isLibraryLoaded])

	// Effect to handle fileId changes - cleanup previous board data
	useEffect(() => {
		setIsLibraryLoaded(false)
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
		return () => {
			saveOnUnmount()
			resetStore()
			resetExcalidrawAPI()
			terminateWorker()
		}
	}, [
		resetStore,
		resetExcalidrawAPI,
		terminateWorker,
		saveOnUnmount,
	])

	const [activeCommentThreadId, setActiveCommentThreadId] = useState<string | null>(null)
	const [commentSidebarDocked, setCommentSidebarDocked] = useState(false)
	const { renderComment, commentThreads, panToThread, deleteThread } = useComment({
		activeCommentThreadId,
		isReadOnly,
		onCommentThreadClick: (commentThreadId) => {
			setActiveCommentThreadId(commentThreadId)
			if (commentThreadId) {
				excalidrawAPI?.toggleSidebar({ name: 'commentSidebar', tab: 'comments', force: true })
			}
		},
		onOpenSidebar: () => {
			excalidrawAPI?.toggleSidebar({ name: 'commentSidebar', tab: 'comments', force: true })
		},
	})

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
		const renderCustomElements = () => {
			renderSmartPicker()
			renderTable()
			renderAssistant()
			renderComment()
			renderEmojiPicker()
		}

		renderCustomElements()

		const excalidrawElement = document.querySelector('.excalidraw')
		if (!excalidrawElement) return

		const observer = new MutationObserver(renderCustomElements)
		observer.observe(excalidrawElement, { attributes: true, attributeFilter: ['class'] })

		return () => observer.disconnect()
	}, [updateLang, renderSmartPicker, renderAssistant, renderComment, renderEmojiPicker, renderTable])

	const onLibraryChange = useCallback(async (items: LibraryItems) => {
		if (!isLibraryLoaded) {
			// Skip updating library items on first load
			return
		}
		try {
			await updateLibraryItems(items, normalizedFileId, getInitialLibraryItemsPresent())
		} catch (error) {
			logger.error('[App] Error syncing library items:', error)
		}
	}, [getInitialLibraryItemsPresent, isLibraryLoaded, normalizedFileId, updateLibraryItems])

	useEffect(() => {
		if (!libraryTemplateDialogItems) {
			return
		}
		requestAnimationFrame(() => libraryTemplateNameInputRef.current?.focus())
	}, [libraryTemplateDialogItems])

	const onLibrarySaveAsTemplate = useCallback((items: LibraryItems, context?: { source?: LibraryTemplateDialogSource }) => {
		if (items.length === 0) {
			showError(t('whiteboard', 'Add items to your library before saving a library template'))
			return
		}

		setLibraryTemplateDialogSource(context?.source === 'selection' ? 'selection' : 'library')
		setLibraryTemplateName('')
		setLibraryTemplateError(null)
		setLibraryTemplateDialogItems(items)
	}, [])

	const closeLibraryTemplateDialog = useCallback(() => {
		if (isSavingLibraryTemplate) {
			return
		}
		setLibraryTemplateDialogItems(null)
		setLibraryTemplateDialogSource('library')
		setLibraryTemplateName('')
		setLibraryTemplateError(null)
	}, [isSavingLibraryTemplate])

	const submitLibraryTemplateDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
		event?.preventDefault()
		if (!libraryTemplateDialogItems || isSavingLibraryTemplate) {
			return
		}

		const templateName = libraryTemplateName.trim()
		if (!templateName) {
			setLibraryTemplateError(t('whiteboard', 'Library template name is required'))
			return
		}

		setIsSavingLibraryTemplate(true)
		setLibraryTemplateError(null)
		try {
			await saveLibraryTemplate(templateName, libraryTemplateDialogItems)
			const libraryItems = await fetchLibraryItems()
			await (excalidrawAPI ?? excalidrawAPIRef.current)?.updateLibrary({
				libraryItems: mergeInitialLibraryItems(
					libraryItems || [],
					getInitialLibraryItems(),
					getInitialLibraryItemsPresent(),
				),
				merge: false,
			})
			setLibraryTemplateDialogItems(null)
			setLibraryTemplateDialogSource('library')
			setLibraryTemplateName('')
			showSuccess(t('whiteboard', 'Saved "{name}" as a library template with {items}.', {
				name: templateName,
				items: formatLibraryItemCount(libraryTemplateDialogItems.length),
			}))
		} catch (error: any) {
			if (error?.status === 409) {
				const conflictMessage = t('whiteboard', 'A library template with this name or the same items already exists')
				setLibraryTemplateError(conflictMessage)
				showError(conflictMessage)
				return
			}
			logger.error('[App] Error saving library template:', error)
			const errorMessage = t('whiteboard', 'Could not save library template')
			setLibraryTemplateError(errorMessage)
			showError(errorMessage)
		} finally {
			setIsSavingLibraryTemplate(false)
		}
	}, [
		excalidrawAPI,
		fetchLibraryItems,
		getInitialLibraryItems,
		getInitialLibraryItemsPresent,
		isSavingLibraryTemplate,
		libraryTemplateDialogItems,
		libraryTemplateName,
		mergeInitialLibraryItems,
		saveLibraryTemplate,
	])

	const libraryReturnUrl = encodeURIComponent(window.location.href)

	// Data loading is now handled by useBoardDataManager

	const onLinkOpen = useCallback((element: any, event: any) => {
		const link = element.link
		if (!link) {
			return
		}
		const { nativeEvent } = event.detail
		const isNewTab = nativeEvent.ctrlKey || nativeEvent.metaKey
		const isNewWindow = nativeEvent.shiftKey
		const isInternalLink = link.startsWith('/') || link.includes(window.location.origin)

		if (isElementLink(link) && !isNewTab && !isNewWindow) {
			event.preventDefault()
			excalidrawAPI?.scrollToContent(link)
			return
		}

		if (isInternalLink && !isNewTab && !isNewWindow) {
			event.preventDefault()
			window.open(link, '_blank')
		}
	}, [excalidrawAPI])

	const generateIdForFile = useCallback(async (file: File): Promise<string> => {
		if (maxImageSizeBytes && file.size > maxImageSizeBytes) {
			const maxSizeMb = maxImageSizeMb ?? 0
			throw new Error(t('whiteboard', 'Max image size is {max} MB', { max: maxSizeMb }))
		}

		// must return an id, excalidraws id generator only runs when the callback prop is not set
		return Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
	}, [maxImageSizeBytes, maxImageSizeMb])

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
					onExcalidrawAPI={handleExcalidrawAPI}
					initialData={initialDataPromise}
					generateIdForFile={generateIdForFile}
					onPointerUpdate={onPointerUpdate}
					onChange={handleOnChange}
					viewModeEnabled={isReadOnly}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					name={fileNameWithoutExtension}
					UIOptions={{
						canvasActions,
						...(isVersionPreview ? { tools: { image: false } } : {}),
					}}
					onLinkOpen={onLinkOpen}
					onLibraryChange={onLibraryChange}
					onLibrarySaveAsTemplate={onLibrarySaveAsTemplate}
					langCode={lang}
					libraryReturnUrl={libraryReturnUrl}
				>
					<Sidebar name="commentSidebar" docked={commentSidebarDocked} onDock={setCommentSidebarDocked}>
						<Sidebar.Header>
							{t('whiteboard', 'Comments')}
						</Sidebar.Header>
						<Sidebar.Tabs style={{ padding: '0.5rem' }}>
							<Sidebar.Tab tab="comments">
								<CommentSidebar
									threads={commentThreads}
									activeThreadId={activeCommentThreadId}
									isReadOnly={isReadOnly}
									onThreadClick={panToThread}
									onDeleteThread={(threadId) => {
										activeCommentThreadId === threadId && setActiveCommentThreadId(null)
										deleteThread(threadId)
									}}
								/>
							</Sidebar.Tab>
						</Sidebar.Tabs>
					</Sidebar>
					<Sidebar name="custom">
						<Sidebar.Header>
							{t('whiteboard', 'Voting')}
						</Sidebar.Header>
						<Sidebar.Tabs style={{ padding: '0.5rem' }}>
							<Sidebar.Tab tab="voting">
								<VotingSidebar
									votings={votings}
									onVote={vote}
									onEndVoting={endVoting}
									onStartVoting={startVoting}
									excalidrawAPI={excalidrawAPI}
									isReadOnly={isReadOnly}
								/>
							</Sidebar.Tab>
						</Sidebar.Tabs>
					</Sidebar>
					{!isVersionPreview && (
						<MemoizedExcalidrawMenu
							fileNameWithoutExtension={fileNameWithoutExtension}
							recordingState={recordingState}
							presentationState={presentationState}
							isTimerVisible={isTimerVisible}
							onToggleTimer={handleToggleTimer}
							gridModeEnabled={gridModeEnabled}
							onToggleGrid={() => setGridModeEnabled(!gridModeEnabled)}
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
				{!isVersionPreview && isTimerVisible && (
					<TimerOverlay
						timer={timerState}
					/>
				)}
				{!isVersionPreview && (
					<CreatorDisplay
						excalidrawAPI={excalidrawAPI}
						settings={creatorDisplaySettings}
					/>
				)}
				{libraryTemplateDialogItems && (
					<div className="library-template-dialog__backdrop">
						<form
							className="library-template-dialog"
							role="dialog"
							aria-modal="true"
							aria-labelledby="library-template-dialog-title"
							onSubmit={submitLibraryTemplateDialog}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.stopPropagation()
									closeLibraryTemplateDialog()
								}
							}}
						>
							<h2 id="library-template-dialog-title">
								{libraryTemplateDialogSource === 'selection'
									? t('whiteboard', 'Save selected items as library template')
									: t('whiteboard', 'Save library as template')}
							</h2>
							<p className="library-template-dialog__hint">
								{t('whiteboard', 'Creates a template for future whiteboards. The canvas is not included.')}
							</p>
							<p className="library-template-dialog__count">
								{formatLibraryItemCount(libraryTemplateDialogItems.length)}
							</p>
							<label htmlFor="library-template-name">
								{t('whiteboard', 'Library template name')}
							</label>
							<input
								id="library-template-name"
								ref={libraryTemplateNameInputRef}
								type="text"
								value={libraryTemplateName}
								disabled={isSavingLibraryTemplate}
								onChange={(event) => setLibraryTemplateName(event.target.value)}
							/>
							{libraryTemplateError && (
								<p className="library-template-dialog__error">
									{libraryTemplateError}
								</p>
							)}
							<div className="library-template-dialog__actions">
								<button
									type="button"
									className="library-template-dialog__button"
									disabled={isSavingLibraryTemplate}
									onClick={closeLibraryTemplateDialog}
								>
									{t('whiteboard', 'Cancel')}
								</button>
								<button
									type="submit"
									className="library-template-dialog__button library-template-dialog__button--primary"
									disabled={isSavingLibraryTemplate}
								>
									{isSavingLibraryTemplate ? t('whiteboard', 'Saving...') : t('whiteboard', 'Save')}
								</button>
							</div>
						</form>
					</div>
				)}
			</div>
		</div>
	)
}
