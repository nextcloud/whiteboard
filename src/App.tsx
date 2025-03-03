/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

// https://github.com/excalidraw/excalidraw/blob/4dc4590f247a0a0d9c3f5d39fe09c00c5cef87bf/examples/excalidraw

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, memo, useRef } from 'react'
import { Excalidraw as ExcalidrawComponent, useHandleLibrary } from '@excalidraw/excalidraw'
import './App.scss'
import './styles/image-fix.css'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardStore } from './stores/useWhiteboardStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { ExcalidrawMenu } from './components/ExcalidrawMenu'
import Embeddable from './Embeddable'
import { useLangStore } from './stores/useLangStore'
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator'
import { useSync } from './hooks/useSync'
import { db } from './database/db' // Import CSS fixes for image flickering

// Memoize the Excalidraw component to prevent unnecessary re-renders
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
}

export default function App({
	fileId,
	isEmbedded,
	fileName,
	publicSharingToken,
}: WhiteboardAppProps) {
	const fileNameWithoutExtension = fileName.split('.').slice(0, -1).join('.')

	const { excalidrawAPI, setExcalidrawAPI } = useExcalidrawStore()
	const {
		setConfig,
		appStatus,
		setAppStatus,
		viewModeEnabled,
		zenModeEnabled,
		gridModeEnabled,
		initialDataPromise,
		resolveInitialData,
	} = useWhiteboardStore()
	const { lang, updateLang } = useLangStore()
	const { theme } = useThemeHandling()
	const { renderSmartPicker } = useSmartPicker()
	const { onChange: onChangeSync } = useSync()
	const { onPointerUpdate, onChange: onCollaborationChange }
		= useCollaboration()

	useEffect(() => {
		setConfig({
			fileId,
			fileName,
			publicSharingToken,
			isReadOnly: false,
			isEmbedded,
		})

		isFirstChangeRef.current = true
	}, [fileId, fileName, publicSharingToken, isEmbedded, setConfig])

	useEffect(() => {
		const initApp = async () => {
			console.log('[App] Starting app initialization')

			renderSmartPicker()

			updateLang()

			if (excalidrawAPI && fileId) {
				console.log(`[App] Loading data for fileId: ${fileId}, excalidrawAPI available:`, {
					apiMethods: Object.keys(excalidrawAPI).join(', '),
				})
				try {
					const localData = await db.get(fileId)

					if (localData) {
						console.log(`[App] Found local data for fileId ${fileId}:`, {
							elementCount: localData.elements ? localData.elements.length : 0,
							hasFiles: !!localData.files,
							hasAppState: !!localData.appState,
							savedAt: localData.savedAt ? new Date(localData.savedAt).toISOString() : 'unknown',
						})

						// Deep clone elements to avoid reference issues
						let elements
						try {
							elements = JSON.parse(JSON.stringify(localData.elements))
							console.log('[App] Successfully parsed elements:', {
								count: elements.length,
								firstElement: elements.length > 0 ? elements[0].type : 'none',
							})
						} catch (parseError) {
							console.error('[App] Error parsing elements:', parseError)
							elements = []
						}

						// Validate elements array
						if (!Array.isArray(elements)) {
							console.error('[App] Elements is not an array, using empty array')
							elements = []
						}

						console.log('[App] Resolving initial data with local data')

						// Prepare the data to load
						const dataToLoad = {
							elements,
							appState:
								localData.appState || initialDataState.appState,
							files: localData.files || {},
							scrollToContent: true,
						}

						// Resolve the promise with the data
						resolveInitialData(dataToLoad)

						// Also directly update the Excalidraw API to ensure data is loaded
						try {
							if (excalidrawAPI && elements.length > 0) {
								console.log('[App] Directly updating Excalidraw API with elements')
								// Update just the elements first to avoid type issues
								excalidrawAPI.updateScene({
									elements,
								})

								// Set the files separately
								if (dataToLoad.files) {
									const files = Object.values(dataToLoad.files)
									if (files.length > 0) {
										excalidrawAPI.addFiles(files)
									}
								}

								// Apply the entire appState to ensure all settings are applied
								if (dataToLoad.appState) {
									console.log('[App] Applying font settings from loaded data')

									// Extract the font settings and other essential properties
									const fontSettings = {
										currentItemFontFamily: dataToLoad.appState.currentItemFontFamily || 3,
										currentItemStrokeWidth: dataToLoad.appState.currentItemStrokeWidth || 1,
										currentItemRoughness: dataToLoad.appState.currentItemRoughness || 0,
										viewBackgroundColor: dataToLoad.appState.viewBackgroundColor || '#ffffff',
									}

									console.log('[App] Font settings to apply:', fontSettings)

									// Update the app state with the font settings
									try {
										// First update with just the elements
										excalidrawAPI.updateScene({
											elements,
											appState: fontSettings,
										})

										// Force a refresh of the scene to ensure settings are applied
										setTimeout(() => {
											try {
												// Get current elements
												const currentElements = excalidrawAPI.getSceneElements()

												// Update again to force a refresh
												excalidrawAPI.updateScene({
													elements: currentElements,
													appState: fontSettings,
												})

												// Try to access any additional API methods that might help
												try {
													// Force a redraw by getting and setting the view mode
													const currentViewMode = excalidrawAPI.getAppState().viewModeEnabled
													excalidrawAPI.updateScene({
														appState: {
															viewModeEnabled: !currentViewMode,
														},
													})

													// Toggle back after a short delay
													setTimeout(() => {
														excalidrawAPI.updateScene({
															appState: {
																viewModeEnabled: currentViewMode,
																...fontSettings,
															},
														})
														console.log('[App] Forced redraw by toggling view mode')
													}, 50)
												} catch (apiError) {
													console.error('[App] Error using additional API methods:', apiError)
												}

												console.log('[App] Forced refresh of scene to apply settings')
											} catch (refreshError) {
												console.error('[App] Error during forced refresh:', refreshError)
											}
										}, 100) // Short delay to ensure first update is processed
									} catch (appStateError) {
										console.error('[App] Error updating appState:', appStateError)
									}
								}
							}
						} catch (updateError) {
							console.error('[App] Error directly updating Excalidraw API:', updateError)
						}
					} else {
						console.log('[App] No local data found, using empty initial data')
						resolveInitialData(initialDataState)
					}
				} catch (error) {
					console.error('[App] Error loading data:', error)
					resolveInitialData(initialDataState)
				}
			} else {
				// If no API or fileId, still resolve with empty data
				console.log('[App] No excalidrawAPI or fileId available, using empty initial data')
				resolveInitialData(initialDataState)
			}

			// Set app as ready after a short delay for smoother UX
			setTimeout(() => {
				console.log('[App] Setting app status to ready')
				setAppStatus('ready')
			}, 150)
		}

		// Start initialization process
		initApp()
	}, [
		excalidrawAPI,
		fileId,
		renderSmartPicker,
		resolveInitialData,
		setAppStatus,
		updateLang,
	])

	// Handle library
	useHandleLibrary({
		excalidrawAPI: useExcalidrawStore((state) => state.excalidrawAPI),
	})

	// Handle link opening
	const onLinkOpen = useCallback(
		(
			element: NonDeletedExcalidrawElement,
			event: CustomEvent<{
				nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement>
			}>,
		) => {
			const link = element.link!
			const { nativeEvent } = event.detail
			const isNewTab = nativeEvent.ctrlKey || nativeEvent.metaKey
			const isNewWindow = nativeEvent.shiftKey
			const isInternalLink
				= link.startsWith('/') || link.includes(window.location.origin)
			if (isInternalLink && !isNewTab && !isNewWindow) {
				event.preventDefault()
			}
		},
		[],
	)

	// Track if this is the first change after loading
	const isFirstChangeRef = useRef(true)

	// Track if this is the first time the API is set
	const isFirstAPISetRef = useRef(true)

	// Handle when the excalidrawAPI is first set
	useEffect(() => {
		if (excalidrawAPI && isFirstAPISetRef.current) {
			isFirstAPISetRef.current = false
			console.log('[App] Excalidraw API first initialized, applying default font settings')

			// Apply default font settings
			try {
				// Define default font settings
				const defaultFontSettings = {
					currentItemFontFamily: 3,
					currentItemStrokeWidth: 1,
					currentItemRoughness: 0,
				}

				// Apply font settings
				excalidrawAPI.updateScene({
					appState: defaultFontSettings,
				})

				// Force a refresh after a short delay
				setTimeout(() => {
					try {
						// Get current elements
						const currentElements = excalidrawAPI.getSceneElements()

						// Try to force a redraw by toggling view mode
						const currentViewMode = excalidrawAPI.getAppState().viewModeEnabled

						// Toggle view mode
						excalidrawAPI.updateScene({
							appState: {
								viewModeEnabled: !currentViewMode,
							},
						})

						// Toggle back and apply font settings again
						setTimeout(() => {
							excalidrawAPI.updateScene({
								elements: currentElements,
								appState: {
									viewModeEnabled: currentViewMode,
									...defaultFontSettings,
								},
							})
							console.log('[App] Forced refresh of scene to apply default settings')
						}, 50)
					} catch (refreshError) {
						console.error('[App] Error during forced refresh of default settings:', refreshError)
					}
				}, 200) // Slightly longer delay for initial setup
			} catch (error) {
				console.error('[App] Error applying default font settings:', error)
			}
		}
	}, [excalidrawAPI])

	// Track previous elements and files to detect real changes
	const lastElementsRef = useRef<any[]>([])
	const lastFilesRef = useRef<any>({})

	// Handle changes to whiteboard content with optimized change detection
	const handleOnChange = useCallback(
		(elements: any, appState: any, files: any) => {
			if (excalidrawAPI && fileId && appStatus === 'ready') {
				// Skip the first change event after loading to prevent immediate sync
				if (isFirstChangeRef.current) {
					console.log('[App] Skipping first onChange event to prevent immediate sync')
					isFirstChangeRef.current = false

					// Store initial state
					lastElementsRef.current = [...elements]
					lastFilesRef.current = { ...files }
					return
				}

				// Check if elements have actually changed
				const elementsChanged = elements.length !== lastElementsRef.current.length
					|| elements.some((el: any, i: number) => el.id !== lastElementsRef.current[i]?.id
										|| el.version !== lastElementsRef.current[i]?.version)

				// Check if files have changed
				const filesChanged = Object.keys(files).length !== Object.keys(lastFilesRef.current).length
					|| Object.keys(files).some(key => !lastFilesRef.current[key])

				// Only process changes if something actually changed
				if (elementsChanged || filesChanged) {
					console.log('[App] Detected real changes, processing updates')

					// Always handle collaboration changes
					onCollaborationChange(elements, appState, files)

					// Handle sync for subsequent changes
					onChangeSync()

					// Update our references
					lastElementsRef.current = [...elements]
					lastFilesRef.current = { ...files }
				} else {
					console.log('[App] No real changes detected, skipping updates')
				}
			}
		},
		[onChangeSync, onCollaborationChange, excalidrawAPI, fileId, appStatus],
	)

	return (
		<div
			className="App"
			style={{ display: 'flex', flexDirection: 'column' }}>
			{appStatus === 'loading'
				? (
					<div
						className="App-loading"
						style={{
							flex: 1,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
						}}>
					Loading whiteboard...
					</div>
				)
				: (
					<>
						<MemoizedNetworkStatusIndicator />
						<div
							className="excalidraw-wrapper"
							style={{ flex: 1, height: '100%' }}>
							<Excalidraw
								validateEmbeddable={() => true}
								renderEmbeddable={Embeddable}
								excalidrawAPI={(api) => setExcalidrawAPI(api)}
								initialData={initialDataPromise}
								onPointerUpdate={onPointerUpdate}
								onChange={handleOnChange}
								viewModeEnabled={viewModeEnabled}
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
								langCode={lang}>
								<MemoizedExcalidrawMenu
									fileNameWithoutExtension={
										fileNameWithoutExtension
									}
								/>
							</Excalidraw>
						</div>
					</>
				)}
		</div>
	)
}
