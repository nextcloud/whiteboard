/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type {
	AppState,
	BinaryFileData,
	BinaryFiles,
	Collaborator,
	ExcalidrawImageElement,
} from '@excalidraw/excalidraw/types/types'
import { CaptureUpdateAction, restoreElements } from '@nextcloud/excalidraw'
import { loadState } from '@nextcloud/initial-state'
import { mergeElementsWithMetadata } from '../utils/mergeElementsWithMetadata'
import { io } from 'socket.io-client'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'
import { useShallow } from 'zustand/react/shallow'
import { throttle, debounce } from 'lodash'
import { db } from '../database/db'
import { buildBroadcastedElementVersions, computeElementVersionHash, mergeSceneElements } from '../utils/syncSceneData'
import type { ClientToServerEvents, CollaborationSocket, ServerToClientEvents } from '../types/collaboration'

enum BroadcastType {
	SceneInit = 'SCENE_INIT', // Incoming scene data from others
	SceneInitRequest = 'SCENE_INIT_REQUEST', // Request targeted bootstrap from current syncer
	SceneUpdate = 'SCENE_UPDATE', // Incremental scene data from others
	SceneRestore = 'SCENE_RESTORE', // Force replace scene from authoritative source
	MouseLocation = 'MOUSE_LOCATION', // Incoming cursor data
	ImageAdd = 'IMAGE_ADD', // Incoming image data from others
	ImageRequest = 'IMAGE_REQUEST', // Request for image data
	ViewportUpdate = 'VIEWPORT_UPDATE', // Incoming viewport changes from others
}

const CURSOR_UPDATE_DELAY = 50
type DisconnectCallback = () => void

export function useCollaboration() {
	const joinedRoomRef = useRef<string | null>(null)
	const pendingSceneUpdatesRef = useRef<readonly ExcalidrawElement[][]>([])
	const pendingImageUpdatesRef = useRef<Map<string, BinaryFileData>>(new Map())
	const pendingSceneReplaceRef = useRef<{
		elements: ExcalidrawElement[]
		files: BinaryFiles
		appState: Partial<AppState>
		scrollToContent: boolean
	} | null>(null)

	const { excalidrawAPI } = useExcalidrawStore(
		useShallow(state => ({
			excalidrawAPI: state.excalidrawAPI,
		})),
	)

	const { getJWT, clearTokens } = useJWTStore(
		useShallow(state => ({
			getJWT: state.getJWT,
			clearTokens: state.clearTokens,
		})),
	)

	const { fileId } = useWhiteboardConfigStore(
		useShallow(state => ({
			fileId: state.fileId,
		})),
	)

	const clientType = useMemo(() => {
		if (typeof window === 'undefined') {
			return 'viewer'
		}
		return loadState('whiteboard', 'isRecording', false) ? 'recording' : 'viewer'
	}, [])

	const {
		setStatus,
		setSocket,
		setDedicatedSyncer,
		replaceBroadcastedElementVersions,
		mergeBroadcastedElementVersions,
		resetSceneSyncState,
		incrementAuthFailure,
		clearAuthError,
		resetStore, // Use resetStore for full cleanup
		setIsInRoom,
	} = useCollaborationStore(
		useShallow(state => ({
			setStatus: state.setStatus,
			setSocket: state.setSocket,
			setDedicatedSyncer: state.setDedicatedSyncer,
			replaceBroadcastedElementVersions: state.replaceBroadcastedElementVersions,
			mergeBroadcastedElementVersions: state.mergeBroadcastedElementVersions,
			resetSceneSyncState: state.resetSceneSyncState,
			incrementAuthFailure: state.incrementAuthFailure,
			clearAuthError: state.clearAuthError,
			resetStore: state.resetStore,
			setIsInRoom: state.setIsInRoom,
		})),
	)

	// --- Remote Update Handlers ---
	const requestMissingImages = useCallback((remoteElements: readonly ExcalidrawElement[]) => {
		if (!excalidrawAPI) return

		const currentFiles = excalidrawAPI.getFiles()
		const currentSocket = useCollaborationStore.getState().socket

		if (!currentSocket?.connected || !fileId) {
			return
		}

		const missingImages = remoteElements
			.filter(el => el.type === 'image'
				&& (el as ExcalidrawImageElement).fileId
				&& !currentFiles[(el as ExcalidrawImageElement).fileId])

		missingImages.forEach(el => {
			const imageId = (el as ExcalidrawImageElement).fileId
			console.log(`[Collaboration] Requesting missing image: ${imageId}`)
			currentSocket.emit('image-get', `${fileId}`, imageId)
		})
	}, [excalidrawAPI, fileId])

	const reconcileAndApplyRemoteElements = useCallback(
		(remoteElements: readonly ExcalidrawElement[]) => {
			if (!excalidrawAPI) return

			try {
				const restoredRemoteElements = restoreElements(remoteElements, null)
				const localElements = excalidrawAPI.getSceneElementsIncludingDeleted() || []
				const appState = excalidrawAPI.getAppState()
				const reconciledElements = mergeElementsWithMetadata(localElements, restoredRemoteElements, appState)
				const localSceneHash = computeElementVersionHash(localElements)
				const reconciledHash = computeElementVersionHash(reconciledElements)
				const remoteVersions = buildBroadcastedElementVersions(restoredRemoteElements)

				if (localSceneHash === reconciledHash) {
					mergeBroadcastedElementVersions(remoteVersions)
					requestMissingImages(restoredRemoteElements)
					return
				}

				mergeBroadcastedElementVersions(remoteVersions)
				excalidrawAPI.updateScene({
					elements: reconciledElements,
					captureUpdate: CaptureUpdateAction.NEVER,
				})
				requestMissingImages(restoredRemoteElements)
			} catch (error) {
				console.error('[Collaboration] Error reconciling remote elements:', error)
			}
		},
		[excalidrawAPI, mergeBroadcastedElementVersions, requestMissingImages],
	)

	const handleRemoteImageAdd = useCallback(
		(file: BinaryFileData) => {
			if (!excalidrawAPI) return

			try {
				// Check if file already exists to avoid duplicates
				const existingFiles = excalidrawAPI.getFiles()
				if (!existingFiles[file.id]) {
					console.log(`[Collaboration] Adding received image: ${file.id}`)
					excalidrawAPI.addFiles([file])
				} else {
					console.log(`[Collaboration] Image already exists: ${file.id}, skipping`)
				}
			} catch (error) {
				console.error('[Collaboration] Error processing received image:', error)
			}
		},
		[excalidrawAPI],
	)

	const queueSceneUpdate = useCallback(
		(remoteElements: readonly ExcalidrawElement[]) => {
			if (!excalidrawAPI) {
				const restoredRemoteElements = restoreElements(remoteElements, null)
				pendingSceneUpdatesRef.current = pendingSceneUpdatesRef.current.length === 0
					? [restoredRemoteElements]
					: [mergeSceneElements(
						pendingSceneUpdatesRef.current[0],
						restoredRemoteElements,
						{} as AppState,
					)]
				return
			}

			reconcileAndApplyRemoteElements(remoteElements)
		},
		[excalidrawAPI, reconcileAndApplyRemoteElements],
	)

	const queueImageUpdate = useCallback(
		(file: BinaryFileData) => {
			if (!excalidrawAPI) {
				pendingImageUpdatesRef.current.set(file.id, file)
				return
			}

			handleRemoteImageAdd(file)
		},
		[excalidrawAPI, handleRemoteImageAdd],
	)

	const applySceneReplacement = useCallback(
		(payload: {
			elements: ExcalidrawElement[]
			files: BinaryFiles
			appState: Partial<AppState>
			scrollToContent: boolean
		}) => {
			if (!excalidrawAPI) {
				return
			}

			try {
				replaceBroadcastedElementVersions(buildBroadcastedElementVersions(payload.elements))
				excalidrawAPI.resetScene()

				const currentAppState = excalidrawAPI.getAppState()
				const sanitizedPayloadAppState = sanitizeAppStateForSync(payload.appState)
				const mergedAppState = {
					...currentAppState,
					...sanitizedPayloadAppState,
					scrollToContent: payload.scrollToContent,
				}

				excalidrawAPI.updateScene({
					elements: payload.elements,
					appState: mergedAppState,
					captureUpdate: CaptureUpdateAction.NEVER,
				})

				const filesArray = Object.values(payload.files || {}).filter(
					(file): file is BinaryFileData => Boolean(file),
				)

				if (filesArray.length > 0) {
					excalidrawAPI.addFiles(filesArray)
				}
			} catch (error) {
				console.error('[Collaboration] Error applying restored scene:', error)
			}
		},
		[excalidrawAPI, replaceBroadcastedElementVersions],
	)

	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}

		if (pendingSceneReplaceRef.current) {
			const payload = pendingSceneReplaceRef.current
			pendingSceneReplaceRef.current = null
			applySceneReplacement(payload)
		}

		if (pendingSceneUpdatesRef.current.length > 0) {
			const [queuedScene] = pendingSceneUpdatesRef.current.splice(0)
			if (queuedScene) {
				reconcileAndApplyRemoteElements(queuedScene)
			}
		}

		if (pendingImageUpdatesRef.current.size > 0) {
			const pendingImages = Array.from(pendingImageUpdatesRef.current.values())
			pendingImageUpdatesRef.current.clear()
			pendingImages.forEach(image => {
				handleRemoteImageAdd(image)
			})
		}
	}, [excalidrawAPI, handleRemoteImageAdd, reconcileAndApplyRemoteElements, applySceneReplacement])

	useEffect(() => {
		pendingSceneUpdatesRef.current = []
		pendingImageUpdatesRef.current.clear()
		pendingSceneReplaceRef.current = null
		resetSceneSyncState()
	}, [fileId, resetSceneSyncState])

	// --- Collaborator State Management ---
	const updateCollaboratorsState = useCallback(
		async (usersPayload: {
			user: { id: string; name: string } // Persistent user ID and display name
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			selectedElementIds: AppState['selectedElementIds']
		}[]) => {
			if (!excalidrawAPI) return

			// Get current user ID from JWT to filter them out
			let currentUserId: string | null = null
			try {
				const token = await getJWT()
				if (token) {
					const { parseJwt } = useJWTStore.getState()
					const decodedToken = parseJwt(token)
					currentUserId = decodedToken?.user?.id || decodedToken?.userid || null
				}
			} catch (error) {
				console.error('[Collaboration] Failed to get current user ID:', error)
			}

			const newCollaborators = new Map<string, Collaborator>()

			usersPayload.forEach((payload) => {
				// Filter out the current user from collaborators list
				if (payload.user.id !== currentUserId) {
					// Use persistent user ID as the key for the map
					newCollaborators.set(payload.user.id, {
						id: payload.user.id,
						username: payload.user.name,
						pointer: payload.pointer,
						button: payload.button,
						selectedElementIds: payload.selectedElementIds,
					})
				}
			})

			excalidrawAPI!.updateScene({ collaborators: newCollaborators })
			console.log(`[Collaboration] Updated collaborators: ${newCollaborators.size} users online (filtered out current user)`)
		},
		[excalidrawAPI, getJWT],
	)

	// Function to update cursor state (unthrottled version)
	const doUpdateCursor = useCallback(
		async (payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			user: { id: string; name: string }
		}) => {
			if (!excalidrawAPI) return

			try {
				// Get current user ID from JWT to filter them out
				let currentUserId: string | null = null
				try {
					const token = await getJWT()
					if (token) {
						const { parseJwt } = useJWTStore.getState()
						const decodedToken = parseJwt(token)
						currentUserId = decodedToken?.user?.id || decodedToken?.userid || null
					}
				} catch (error) {
					console.error('[Collaboration] Failed to get current user ID:', error)
				}

				// Don't update cursor for the current user
				if (payload.user.id === currentUserId) {
					return
				}

				// Get current collaborators directly from Excalidraw
				const currentCollaborators = excalidrawAPI.getAppState().collaborators || new Map<string, Collaborator>()

				// Create a new collaborators map
				const updatedCollaborators = new Map<string, Collaborator>(currentCollaborators)

				// Update or add the collaborator
				updatedCollaborators.set(payload.user.id, {
					id: payload.user.id,
					username: payload.user.name,
					pointer: payload.pointer,
					button: payload.button,
					// We don't need selectedElementIds for cursor updates
					selectedElementIds: {}, // Use empty object instead of full selectedElementIds
				})

				// Update Excalidraw scene with all changes at once
				excalidrawAPI.updateScene({ collaborators: updatedCollaborators })
			} catch (error) {
				console.error('[Collaboration] Error updating cursor:', error)
			}
		},
		[excalidrawAPI, getJWT],
	)

	const throttledUpdateCursor = useMemo(() =>
		throttle(doUpdateCursor, CURSOR_UPDATE_DELAY, { leading: false, trailing: true })
	, [doUpdateCursor])

	const updateCursorState = useCallback(
		(payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			selectedElementIds: AppState['selectedElementIds']
			user: { id: string; name: string }
		}) => {
			if (!payload.user?.id || !payload.pointer) {
				console.warn('[Collaboration] Invalid cursor payload:', payload)
				return
			}

			throttledUpdateCursor({
				pointer: payload.pointer,
				button: payload.button,
				user: payload.user,
			})
		},
		[throttledUpdateCursor],
	)

	const updateViewportState = useCallback(
		(payload: {
			userId: string
			scrollX: number
			scrollY: number
			zoom: number
		}) => {
			if (!payload.userId || typeof payload.scrollX !== 'number' || typeof payload.scrollY !== 'number' || typeof payload.zoom !== 'number') {
				console.warn('[Collaboration] Invalid viewport payload:', payload)
				return
			}

			const {
				followedUserId,
				presenterId,
				isPresentationMode,
				autoFollowPresenter,
			} = useCollaborationStore.getState()

			// Debug logging for recording agents and presentation
			console.log(`[Collaboration] Viewport update received from user ${payload.userId}`, {
				followedUserId,
				presenterId,
				isPresentationMode,
				autoFollowPresenter,
				payload,
			})

			// Determine if we should follow this user's viewport
			let shouldFollow = false
			let followReason = ''

			// 1. Explicit following (recording agents, manual follow)
			if (followedUserId === payload.userId) {
				shouldFollow = true
				followReason = 'explicit follow'
			} else if (isPresentationMode
					 && presenterId === payload.userId
					 && autoFollowPresenter
					 && !followedUserId) { // Don't override explicit following
				// 2. Auto-follow presenter during presentation mode
				shouldFollow = true
				followReason = 'presentation auto-follow'
			}

			if (shouldFollow && excalidrawAPI) {
				console.log(`[Collaboration] Applying viewport from ${payload.userId} (${followReason}):`, payload)
				const currentAppState = excalidrawAPI.getAppState()

				// Apply viewport changes with smooth transition
				excalidrawAPI.updateScene({
					appState: {
						...currentAppState,
						scrollX: payload.scrollX,
						scrollY: payload.scrollY,
						zoom: { value: payload.zoom },
					},
				})
			} else if (followedUserId || (isPresentationMode && presenterId)) {
				console.log(`[Collaboration] Ignoring viewport update from ${payload.userId}`, {
					reason: followedUserId
						? `following ${followedUserId}`
						: isPresentationMode && !autoFollowPresenter
							? 'auto-follow disabled'
							: 'not presenter',
				})
			}
		},
		[excalidrawAPI],
	)

	const clearExcalidrawCollaborators = useCallback(() => {
		if (excalidrawAPI) {
			excalidrawAPI.updateScene({ collaborators: new Map() })
		}
		// No need to call clearCollaborators() as setStatus('offline') will clear them
	}, [excalidrawAPI])

	// --- Connection Management ---
	const handleTokenRefresh = useCallback(async () => {
		console.log('[Collaboration] Refreshing authentication token...')
		setStatus('connecting') // Indicate attempting to connect/refresh

		clearTokens()

		try {
			const newToken = await getJWT()
			const currentSocket = useCollaborationStore.getState().socket

			if (!newToken) {
				throw new Error('Failed to obtain new JWT token.')
			}

			if (currentSocket) {
				currentSocket.auth = { token: newToken }
				if (!currentSocket.connected) {
					currentSocket.connect()
				}
			} else {
				console.log('[Collaboration] Socket missing, initiating full connection after token refresh.')
				await connectSocketRef.current()
			}
		} catch (error) {
			console.error('[Collaboration] Failed to refresh token or connect:', error)
			setStatus('offline')
		}
	}, [getJWT, clearTokens, setStatus])

	// Create a debounced version of the room join function to prevent multiple rapid joins
	const debouncedJoinRoom = useMemo(() =>
		debounce((socket: CollaborationSocket, roomId: string) => {
			console.log(`[Collaboration] Debounced join room ${roomId}`)
			socket.emit('join-room', roomId)
		}, 300, { leading: true, trailing: false }),
	[])

	const handleInitRoom = useCallback(() => {
		// Use the fileId from our selective subscription instead of getState
		const currentSocket = useCollaborationStore.getState().socket
		const roomIdStr = `${fileId}`

		if (!fileId || !currentSocket || !currentSocket.connected) {
			console.warn('[Collaboration] Cannot join room:', {
				hasFileId: !!fileId,
				hasSocket: !!currentSocket,
				connected: currentSocket?.connected,
			})
			return
		}

		// Check if we've already joined this room with this socket
		if (joinedRoomRef.current === roomIdStr) {
			console.log(`[Collaboration] Already joined room ${roomIdStr}, skipping`)
			return
		}

		console.log(`[Collaboration] Joining room ${roomIdStr}`)
		joinedRoomRef.current = roomIdStr
		debouncedJoinRoom(currentSocket, roomIdStr)
	}, [fileId, debouncedJoinRoom]) // Dependencies read via store state

	const sendSceneBootstrapToSocket = useCallback((targetSocketId: string) => {
		const currentExcalidrawAPI = useExcalidrawStore.getState().excalidrawAPI
		const currentFileId = useWhiteboardConfigStore.getState().fileId
		const { isDedicatedSyncer, socket } = useCollaborationStore.getState()
		if (!isDedicatedSyncer || !socket || !socket.connected || !currentFileId || !currentExcalidrawAPI) {
			return
		}

		if (socket.id === targetSocketId) {
			return
		}

		console.log(`[Collaboration] Sending targeted scene bootstrap to socket: ${targetSocketId}`)
		const sceneElements = currentExcalidrawAPI.getSceneElementsIncludingDeleted()
		const sceneData = {
			type: BroadcastType.SceneInit,
			payload: {
				elements: sceneElements,
			},
		}
		const sceneBuffer = new TextEncoder().encode(JSON.stringify(sceneData))
		socket.emit('server-direct-broadcast', `${currentFileId}`, targetSocketId, sceneBuffer, [])

		const files = currentExcalidrawAPI.getFiles()
		Object.entries(files).forEach(([, file]) => {
			if (!file?.dataURL) {
				return
			}

			const fileData = { type: BroadcastType.ImageAdd, payload: { file } }
			const fileBuffer = new TextEncoder().encode(JSON.stringify(fileData))
			socket.emit('server-direct-broadcast', `${currentFileId}`, targetSocketId, fileBuffer, [])
		})
	}, [])

	const requestSceneBootstrap = useCallback((targetSocketId: string) => {
		const socket = useCollaborationStore.getState().socket
		if (!socket || !socket.connected || !fileId) {
			return
		}

		const requestData = {
			type: BroadcastType.SceneInitRequest,
			payload: {
				socketId: targetSocketId,
			},
		}
		const requestBuffer = new TextEncoder().encode(JSON.stringify(requestData))
		socket.emit('server-broadcast', `${fileId}`, requestBuffer, [])
	}, [fileId])

	const handleClientBroadcast = useCallback(
		async (data: ArrayBuffer) => {
			try {
				const decoded = JSON.parse(new TextDecoder().decode(data))

				if (!decoded || !decoded.type) {
					console.warn('[Collaboration] Invalid broadcast data:', decoded)
					return
				}

				if (useWhiteboardConfigStore.getState().isVersionPreview) {
					console.log('[Collaboration] Ignoring broadcast while in version preview')
					return
				}

				switch (decoded.type) {
				case BroadcastType.SceneRestore: {
					const payload = decoded.payload || {}

					if (!Array.isArray(payload.elements)) {
						console.warn('[Collaboration] Invalid SceneRestore payload:', payload)
						break
					}

					try {
						const restoredElements = restoreElements(payload.elements, null) as ExcalidrawElement[]
						const files = (payload.files || {}) as BinaryFiles
						const appStatePatch: Partial<AppState> = sanitizeAppStateForSync(payload.appState)
						const scrollToContent = payload.scrollToContent ?? true

						// Clear pending queue state since we have an authoritative snapshot
						pendingSceneUpdatesRef.current = []
						pendingImageUpdatesRef.current.clear()

						if (excalidrawAPI) {
							applySceneReplacement({
								elements: restoredElements,
								files,
								appState: appStatePatch,
								scrollToContent,
							})
						} else {
							pendingSceneReplaceRef.current = {
								elements: restoredElements,
								files,
								appState: appStatePatch,
								scrollToContent,
							}
						}

						// Persist authoritative snapshot locally to avoid stale IndexedDB data
						if (fileId) {
							try {
								await db.put(
									fileId,
									restoredElements,
									files || {},
									appStatePatch,
									{
										hasPendingLocalChanges: false,
										lastSyncedHash: computeElementVersionHash(restoredElements),
									},
								)
							} catch (persistError) {
								console.error('[Collaboration] Failed to persist restored scene to IndexedDB:', persistError)
							}
						}
					} catch (error) {
						console.error('[Collaboration] Error handling SceneRestore broadcast:', error)
					}
					break
				}
				case BroadcastType.SceneInit:
				case BroadcastType.SceneUpdate:
					if (Array.isArray(decoded.payload?.elements)) {
						queueSceneUpdate(decoded.payload.elements)
					} else {
						console.warn('[Collaboration] Invalid scene payload:', decoded.payload)
					}
					break
				case BroadcastType.SceneInitRequest:
					if (typeof decoded.payload?.socketId === 'string') {
						sendSceneBootstrapToSocket(decoded.payload.socketId)
					} else {
						console.warn('[Collaboration] Invalid scene bootstrap request payload:', decoded.payload)
					}
					break
				case BroadcastType.MouseLocation:
					if (decoded.payload && typeof decoded.payload === 'object') {
						updateCursorState(decoded.payload)
					} else {
						console.warn('[Collaboration] Invalid MouseLocation payload:', decoded.payload)
					}
					break
				case BroadcastType.ImageAdd:
					// Validate file exists before processing
					if (decoded.payload?.file) {
						queueImageUpdate(decoded.payload.file)
					} else {
						console.warn('[Collaboration] Invalid ImageAdd payload:', decoded.payload)
					}
					break
				case BroadcastType.ImageRequest:
					// Handle image request from another client
					if (decoded.payload?.fileId && excalidrawAPI) {
						const requestedFileId = decoded.payload.fileId
						const files = excalidrawAPI.getFiles()
						const file = files[requestedFileId]

						if (file && file.dataURL) {
							console.log(`[Collaboration] Sending requested image: ${requestedFileId}`)
							const currentSocket = useCollaborationStore.getState().socket

							if (currentSocket && currentSocket.connected && fileId) {
								// Send the image using the existing broadcast mechanism
								const fileData = { type: BroadcastType.ImageAdd, payload: { file } }
								const fileJson = JSON.stringify(fileData)
								const fileBuffer = new TextEncoder().encode(fileJson)
								currentSocket.emit('server-broadcast', `${fileId}`, fileBuffer, [])
							}
						}
					}
					break
				case BroadcastType.ViewportUpdate:
					if (decoded.payload && typeof decoded.payload === 'object') {
						updateViewportState(decoded.payload)
					} else {
						console.warn('[Collaboration] Invalid ViewportUpdate payload:', decoded.payload)
					}
					break
				default:
					console.debug('[Collaboration] Unknown broadcast type:', decoded.type)
					break
				}
			} catch (error) {
				console.error('[Collaboration] Error processing client broadcast:', error)
			}
		},
		[queueSceneUpdate, sendSceneBootstrapToSocket, updateCursorState, queueImageUpdate, updateViewportState, excalidrawAPI, fileId, applySceneReplacement],
	)

	const handleSyncDesignate = useCallback((data: { isSyncer: boolean }) => {
		console.log(`[Collaboration] Sync designation received: ${data.isSyncer}`)
		setDedicatedSyncer(data.isSyncer)
	}, [setDedicatedSyncer])

	const handleUserJoined = useCallback((data: { socketId: string }) => {
		const socket = useCollaborationStore.getState().socket
		if (!socket || !socket.connected || !fileId || socket.id !== data.socketId) {
			return
		}

		console.log(`[Collaboration] Requesting targeted scene bootstrap for socket: ${data.socketId}`)
		requestSceneBootstrap(data.socketId)
	}, [fileId, requestSceneBootstrap])

	// No custom reconnection strategy needed - socket.io will handle reconnection with Infinity attempts

	// --- Socket Event Handlers Setup ---
	const setupSocketEventHandlers = useCallback(
		(socketInstance: CollaborationSocket) => {
			// Clear all listeners for safety when reusing a socket instance
			socketInstance.removeAllListeners()

			// --- Connection Lifecycle ---
			socketInstance.on('connect_error', async (error: Error) => {
				console.error('[Collaboration] Connection Error:', error.message)
				if (error.message.includes('Authentication error')) {
					// Track authentication failure - this is likely a JWT secret mismatch
					incrementAuthFailure('jwt_secret_mismatch', 'WebSocket authentication failed - possible JWT secret mismatch')

					// Check if we should stop trying to reconnect due to persistent auth failures
					const { authError } = useCollaborationStore.getState()
					if (authError.isPersistent) {
						console.warn('[Collaboration] Persistent authentication failures detected, stopping reconnection attempts')
						socketInstance.disconnect()
						setStatus('offline')
						return
					}

					// Stop auto reconnection attempts on auth error and try token refresh
					socketInstance.disconnect()
					await handleTokenRefreshRef.current()
				} else {
					setStatus('offline')
				}
			})

			socketInstance.on('connect_timeout', () => {
				console.warn('[Collaboration] Connection timeout')
				setStatus('offline')
			})

			socketInstance.on('connect', () => {
				console.log('[Collaboration] Socket connect event fired - setting status to online')
				setStatus('online')
				setIsInRoom(false) // not joined yet

				// Only clear auth errors if this was not a JWT secret mismatch
				// JWT secret mismatch is a persistent configuration issue that won't be resolved by connection success
				const { authError } = useCollaborationStore.getState()
				if (authError.type !== 'jwt_secret_mismatch') {
					clearAuthError()
				}

				// Reset room join tracking on new connection
				joinedRoomRef.current = null
				console.log('[Collaboration] Reset room join tracking due to connect event')

				// We don't need to call handleInitRoom() here because the server will send an init-room event
				// which will trigger the room join. This prevents double room joins.
			})

			socketInstance.on('disconnect', (reason) => {
				console.warn(`[Collaboration] Socket disconnect event fired: ${reason}`)
				clearExcalidrawCollaboratorsRef.current()
				setIsInRoom(false)

				// Only set to offline if this is an intentional disconnect
				// For server disconnects, Socket.IO will automatically try to reconnect
				if (reason === 'io client disconnect') {
					console.log('[Collaboration] Client disconnect - setting status to offline')
					setStatus('offline')
				} else {
					console.log('[Collaboration] Server disconnect detected, Socket.IO will attempt auto-reconnect')
					setStatus('reconnecting')
				}

				// Reset room join tracking on disconnect
				joinedRoomRef.current = null
				console.log('[Collaboration] Reset room join tracking due to disconnect')
			})

			socketInstance.on('reconnect', (attemptNumber) => {
				console.log(`[Collaboration] Socket reconnect event fired after ${attemptNumber} attempts - setting status to online`)

				// Update status to online on successful reconnect
				setStatus('online')
				setIsInRoom(false) // will join again

				// Clear auth errors since we're successfully reconnected
				const { authError } = useCollaborationStore.getState()
				if (authError.type !== 'jwt_secret_mismatch') {
					clearAuthError()
				}

				// Reset room join tracking on reconnect
				joinedRoomRef.current = null
				console.log('[Collaboration] Reset room join tracking due to reconnect event')
			})

			socketInstance.on('reconnect_attempt', (attemptNumber) => {
				console.log(`[Collaboration] Reconnection attempt ${attemptNumber}`)
				setStatus('reconnecting')
			})

			socketInstance.on('reconnect_error', (error) => {
				console.error('[Collaboration] Reconnection error:', error)
			})

			socketInstance.on('reconnect_failed', () => {
				console.error('[Collaboration] Reconnection failed - giving up')
				setStatus('offline')
			})

			socketInstance.on('reconnect_error', (error) => {
				console.error('[Collaboration] Reconnection error:', error)
			})

			// --- Application Logic Events ---
			socketInstance.on('init-room', () => {
				console.log('[Collaboration] Received init-room event from server, initiating room join')

				// Force reset room join tracking since we're getting init-room
				// This handles cases where the connect/reconnect events don't fire properly
				const wasAlreadyJoined = joinedRoomRef.current
				joinedRoomRef.current = null
				console.log(`[Collaboration] Force reset room join tracking (was: ${wasAlreadyJoined})`)

				// Fallback: If we receive init-room but status is still connecting or offline,
				// and the socket is actually connected, update status to online
				// This handles cases where the 'connect' event doesn't fire properly
				const currentStatus = useCollaborationStore.getState().status
				if ((currentStatus === 'connecting' || currentStatus === 'offline') && socketInstance.connected) {
					console.log(`[Collaboration] Fallback: Setting status to online based on init-room + socket.connected (was: ${currentStatus})`)
					setStatus('online')

					// Clear auth errors since we're successfully connected
					const { authError } = useCollaborationStore.getState()
					if (authError.type !== 'jwt_secret_mismatch') {
						clearAuthError()
					}
				}

				// This is the primary trigger for joining a room - the server sends this event
				// when a socket connects, and we respond by joining the appropriate room
				handleInitRoomRef.current()
			})

			socketInstance.on('room-user-change', (data) => {
				console.log(`[Collaboration] Room user change: ${data.length} users`)
				setIsInRoom(true)
				updateCollaboratorsStateRef.current(data)
			})

			socketInstance.on('client-broadcast', (data) => {
				handleClientBroadcastRef.current(data).catch((error) => {
					console.error('[Collaboration] Error processing client broadcast:', error)
				})
			})
			socketInstance.on('sync-designate', (data) => {
				handleSyncDesignateRef.current(data)
			})

			socketInstance.on('user-joined', (data) => {
				console.log(`[Collaboration] User joined: ${data.userName} (${data.userId})`)
				handleUserJoinedRef.current(data)
			})

			// Handle request for presenter's viewport
			socketInstance.on('request-presenter-viewport', async () => {
				console.log('[Collaboration] Presenter viewport requested')
				const currentExcalidrawAPI = excalidrawAPIRef.current
				const currentFileId = fileIdRef.current

				// Check if we're the presenter
				const { isPresenting } = useCollaborationStore.getState()

				if (isPresenting && currentExcalidrawAPI && currentFileId) {
					const appState = currentExcalidrawAPI.getAppState()
					const { presenterId } = useCollaborationStore.getState()

					const viewportData = {
						type: BroadcastType.ViewportUpdate,
						payload: {
							userId: presenterId, // Use the presenterId
							scrollX: appState.scrollX || 0,
							scrollY: appState.scrollY || 0,
							zoom: appState.zoom?.value || 1,
						},
					}

					// Broadcast viewport to all users
					const viewportJson = JSON.stringify(viewportData)
					const viewportBuffer = new TextEncoder().encode(viewportJson)
					socketInstance.emit('server-broadcast', `${currentFileId}`, viewportBuffer, [])

					console.log('[Collaboration] Sent presenter viewport:', viewportData.payload)
				}
			})

			// Handle viewport request from another user (for presentation follow)
			socketInstance.on('send-viewport-request', async (data) => {
				const { requesterId } = data
				console.log(`[Collaboration] Viewport requested by user ${requesterId}`)
				const currentExcalidrawAPI = excalidrawAPIRef.current
				const currentFileId = fileIdRef.current

				// Send our current viewport back to the requester
				if (currentExcalidrawAPI && currentFileId) {
					const appState = currentExcalidrawAPI.getAppState()

					// Check if we're the presenter
					const { isPresenting, presenterId: currentPresenterId } = useCollaborationStore.getState()

					// Use the presenterId if we're presenting, otherwise use JWT userId
					let userId = 'unknown'
					if (isPresenting && currentPresenterId) {
						// If we're presenting, use our presenter ID
						userId = currentPresenterId
					} else {
						// Otherwise get our actual user ID from JWT
						const jwt = await getJWTRef.current()
						if (jwt) {
							try {
								const payload = JSON.parse(atob(jwt.split('.')[1]))
								userId = payload.userid || payload.userId || 'unknown'
							} catch (e) {
								console.error('[Collaboration] Failed to parse JWT for user ID')
							}
						}
					}

					const viewportData = {
						type: BroadcastType.ViewportUpdate,
						payload: {
							userId,
							scrollX: appState.scrollX || 0,
							scrollY: appState.scrollY || 0,
							zoom: appState.zoom?.value || 1,
						},
					}

					// Send directly to the requester via server broadcast
					const viewportJson = JSON.stringify(viewportData)
					const viewportBuffer = new TextEncoder().encode(viewportJson)
					socketInstance.emit('server-broadcast', `${currentFileId}`, viewportBuffer, [])

					console.log('[Collaboration] Sent viewport to requester:', viewportData.payload)
				}
			})

			// Also handle presenter viewport broadcast (when presenter moves)
			socketInstance.on('presenter-viewport-update', (data) => {
				const { viewportData } = data
				if (viewportData && viewportData.type === BroadcastType.ViewportUpdate) {
					updateViewportState(viewportData.payload)
				}
			})

			return socketInstance
		},
		[ // Ensure all dependencies using state/actions are listed
			setStatus, handleInitRoom, handleTokenRefresh,
			updateCollaboratorsState, handleClientBroadcast, handleSyncDesignate,
			clearExcalidrawCollaborators, handleUserJoined, excalidrawAPI, fileId, getJWT,
		],
	)

	// --- Socket Connection Logic ---
	const connectSocketRef = useRef(() => Promise.resolve())
	const socketInstanceRef = useRef<CollaborationSocket | null>(null)
	const disconnectSocketRef = useRef<DisconnectCallback>(function noop() {})
	const resetStoreRef = useRef(resetStore)
	const debouncedJoinRoomRef = useRef(debouncedJoinRoom)
	const throttledUpdateCursorRef = useRef(throttledUpdateCursor)
	const handleTokenRefreshRef = useRef(handleTokenRefresh)
	const handleInitRoomRef = useRef(handleInitRoom)
	const updateCollaboratorsStateRef = useRef(updateCollaboratorsState)
	const handleClientBroadcastRef = useRef(handleClientBroadcast)
	const handleSyncDesignateRef = useRef(handleSyncDesignate)
	const clearExcalidrawCollaboratorsRef = useRef(clearExcalidrawCollaborators)
	const handleUserJoinedRef = useRef(handleUserJoined)
	const excalidrawAPIRef = useRef(excalidrawAPI)
	const fileIdRef = useRef(fileId)
	const getJWTRef = useRef(getJWT)

	const connectSocket = useCallback(async () => {
		// Use the fileId from our selective subscription instead of getState
		const { socket: currentSocket, status: currentStatus } = useCollaborationStore.getState()

		if (!fileId) {
			console.warn('[Collaboration] Cannot connect: invalid fileId.')
			setStatus('offline')
			return
		}

		// Avoid reconnecting if already online or connecting
		if (currentStatus === 'online' || currentStatus === 'connecting') {
			console.log('[Collaboration] Already online or connecting, skipping connection attempt')
			return
		}

		// Check if we should avoid reconnecting due to persistent auth failures
		const { authError } = useCollaborationStore.getState()
		if (authError.isPersistent && authError.type === 'jwt_secret_mismatch') {
			console.warn('[Collaboration] Skipping connection attempt due to persistent JWT secret mismatch')
			setStatus('offline')
			return
		}

		// Reset room join tracking when creating a new connection
		joinedRoomRef.current = null

		// Disconnect existing socket instance if present
		if (currentSocket) {
			console.log('[Collaboration] Disconnecting existing socket before creating new one')
			currentSocket.disconnect()
			setSocket(null) // Ensure store reflects disconnected state

			// Allow some time for the socket to fully disconnect
			await new Promise(resolve => setTimeout(resolve, 100))
		}

		// Reset socket state for a fresh attempt (auto reconnect managed by socket.io)
		try {
			setStatus('connecting')
			// Get collaboration backend URL from the WhiteboardConfigStore
			const collabBackendUrl = useWhiteboardConfigStore.getState().collabBackendUrl
			if (!collabBackendUrl) throw new Error('Collaboration backend URL missing.')

			const token = await getJWT()
			if (!token) throw new Error('JWT token missing.')

			const url = new URL(collabBackendUrl)
			const path = (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/') + 'socket.io'

			// Check if we already have a socket instance in our ref
			if (socketInstanceRef.current) {
				console.log('[Collaboration] Reusing existing socket instance')
				socketInstanceRef.current.auth = { token, clientType }
				setupSocketEventHandlers(socketInstanceRef.current)
				setSocket(socketInstanceRef.current)

				if (!socketInstanceRef.current.connected) {
					socketInstanceRef.current.connect()
				}
				return
			}

			console.log('[Collaboration] Creating new socket instance')
			const newSocket: CollaborationSocket = io<ServerToClientEvents, ClientToServerEvents>(url.origin, {
				path,
				auth: { token, clientType },
				transports: ['websocket'],
				reconnection: true, // Enable auto reconnect
				reconnectionDelay: 1000, // Start with 1s delay
				reconnectionDelayMax: 10000, // Max 10s delay between reconnection attempts
				reconnectionAttempts: Infinity, // Never stop trying to reconnect
				// Enable per-message deflate compression
				perMessageDeflate: {
					threshold: 1024, // Only compress messages larger than 1KB
					zlibDeflateOptions: {
						level: 6, // Medium compression level
						memLevel: 8, // Memory level for optimal speed
						windowBits: 15, // Window size
					},
					zlibInflateOptions: {
						windowBits: 15, // Window size
					},
				},
			})

			// Store the socket instance in our ref
			socketInstanceRef.current = newSocket

			setupSocketEventHandlers(newSocket)
			setSocket(newSocket)
			newSocket.connect()

		} catch (error) {
			console.error('[Collaboration] Connection initiation failed:', error)
			setSocket(null)
			socketInstanceRef.current = null
			setStatus('offline') // Set status to offline on failure
		}
	}, [
		getJWT, setStatus, setSocket, setupSocketEventHandlers,
		fileId,
		clientType,
	])

	useEffect(() => {
		connectSocketRef.current = connectSocket
	}, [connectSocket])

	// --- Disconnect Logic ---
	const disconnectSocket = useCallback(() => {
		const currentSocket = useCollaborationStore.getState().socket

		if (currentSocket) {
			console.log('[Collaboration] Disconnecting socket')

			// Remove all listeners first to prevent any callbacks during disconnect
			currentSocket.removeAllListeners()

			// Disconnect the socket
			currentSocket.disconnect()

			// Reset state
			setSocket(null)
			setStatus('offline') // This will also clear collaborators in the store
			clearExcalidrawCollaborators() // Clear from Excalidraw UI
			setIsInRoom(false)

			// Reset room join tracking
			joinedRoomRef.current = null
		}

		// Also clear the socket instance ref
		socketInstanceRef.current = null
	}, [setSocket, setStatus, clearExcalidrawCollaborators])

	useEffect(() => {
		disconnectSocketRef.current = disconnectSocket
	}, [disconnectSocket])

	useEffect(() => {
		resetStoreRef.current = resetStore
	}, [resetStore])

	useEffect(() => {
		debouncedJoinRoomRef.current = debouncedJoinRoom
	}, [debouncedJoinRoom])

	useEffect(() => {
		throttledUpdateCursorRef.current = throttledUpdateCursor
	}, [throttledUpdateCursor])

	useEffect(() => {
		handleTokenRefreshRef.current = handleTokenRefresh
	}, [handleTokenRefresh])

	useEffect(() => {
		handleInitRoomRef.current = handleInitRoom
	}, [handleInitRoom])

	useEffect(() => {
		updateCollaboratorsStateRef.current = updateCollaboratorsState
	}, [updateCollaboratorsState])

	useEffect(() => {
		handleClientBroadcastRef.current = handleClientBroadcast
	}, [handleClientBroadcast])

	useEffect(() => {
		handleSyncDesignateRef.current = handleSyncDesignate
	}, [handleSyncDesignate])

	useEffect(() => {
		clearExcalidrawCollaboratorsRef.current = clearExcalidrawCollaborators
	}, [clearExcalidrawCollaborators])

	useEffect(() => {
		handleUserJoinedRef.current = handleUserJoined
	}, [handleUserJoined])

	useEffect(() => {
		excalidrawAPIRef.current = excalidrawAPI
	}, [excalidrawAPI])

	useEffect(() => {
		fileIdRef.current = fileId
	}, [fileId])

	useEffect(() => {
		getJWTRef.current = getJWT
	}, [getJWT])

	// --- Effects ---
	// Connect/Disconnect based on fileId
	useEffect(() => {
		if (fileId) {
			console.log(`[Collaboration] FileId ${fileId} active, connecting socket`)
			connectSocketRef.current().catch((error) => {
				console.error('[Collaboration] Connection effect failed:', error)
			})
		} else {
			console.log('[Collaboration] No fileId, disconnecting socket')
			disconnectSocketRef.current()
			setIsInRoom(false)
		}

		// Cleanup when fileId changes
		return () => {
			// Cancel any pending debounced room joins
			debouncedJoinRoomRef.current.cancel()
		}
	}, [fileId, setIsInRoom])

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			console.log('[Collaboration] Unmounting, performing full cleanup')

			// Cancel any pending operations
			debouncedJoinRoomRef.current.cancel()
			throttledUpdateCursorRef.current.cancel()

			// Disconnect socket
			disconnectSocketRef.current()

			// Reset store state
			resetStoreRef.current()
		}
	}, [])

	// --- Exported Hook API ---
	return {
		connect: connectSocket, // For manual connection control (if needed)
		disconnect: disconnectSocket, // For manual disconnection control
	}
}
