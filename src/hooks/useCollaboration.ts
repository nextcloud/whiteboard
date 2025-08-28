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
	Collaborator,
	ExcalidrawImageElement,
} from '@excalidraw/excalidraw/types/types'
import { restoreElements } from '@excalidraw/excalidraw'
import { reconcileElements } from '../util'
import { io, type Socket } from 'socket.io-client'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useShallow } from 'zustand/react/shallow'
import { throttle, debounce } from 'lodash'

enum BroadcastType {
	SceneInit = 'SCENE_INIT', // Incoming scene data from others
	MouseLocation = 'MOUSE_LOCATION', // Incoming cursor data
	ImageAdd = 'IMAGE_ADD', // Incoming image data from others
	ImageRequest = 'IMAGE_REQUEST', // Request for image data
	ViewportUpdate = 'VIEWPORT_UPDATE', // Incoming viewport changes from others
}

const CURSOR_UPDATE_DELAY = 50

export function useCollaboration() {
	const joinedRoomRef = useRef<string | null>(null)

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

	const {
		setStatus,
		setSocket,
		setDedicatedSyncer,
		incrementAuthFailure,
		clearAuthError,
		resetStore, // Use resetStore for full cleanup
	} = useCollaborationStore(
		useShallow(state => ({
			setStatus: state.setStatus,
			setSocket: state.setSocket,
			setDedicatedSyncer: state.setDedicatedSyncer,
			incrementAuthFailure: state.incrementAuthFailure,
			clearAuthError: state.clearAuthError,
			resetStore: state.resetStore,
		})),
	)

	// --- Remote Update Handlers ---
	const reconcileAndApplyRemoteElements = useCallback(
		(remoteElements: readonly ExcalidrawElement[]) => {
			if (!excalidrawAPI) return

			try {
				// Restore and reconcile elements
				const restoredRemoteElements = restoreElements(remoteElements, null)
				const localElements = excalidrawAPI.getSceneElementsIncludingDeleted() || []
				const appState = excalidrawAPI.getAppState()
				const reconciledElements = reconcileElements(localElements, restoredRemoteElements, appState)
				excalidrawAPI.updateScene({ elements: reconciledElements })

				// Request any missing images
				const currentFiles = excalidrawAPI.getFiles()
				const currentSocket = useCollaborationStore.getState().socket

				if (currentSocket?.connected && fileId) {
					// Find image elements with missing file data
					const missingImages = restoredRemoteElements
						.filter(el => el.type === 'image'
							&& (el as ExcalidrawImageElement).fileId
							&& !currentFiles[(el as ExcalidrawImageElement).fileId])

					// Request each missing image
					missingImages.forEach(el => {
						const imageId = (el as ExcalidrawImageElement).fileId
						console.log(`[Collaboration] Requesting missing image: ${imageId}`)
						currentSocket.emit('image-get', `${fileId}`, imageId)
					})
				}
			} catch (error) {
				console.error('[Collaboration] Error reconciling remote elements:', error)
			}
		},
		[excalidrawAPI, fileId],
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

	// --- Collaborator State Management ---
	const updateCollaboratorsState = useCallback(
		(usersPayload: {
			user: { id: string; name: string } // Persistent user ID and display name
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			selectedElementIds: AppState['selectedElementIds']
		}[]) => {
			if (!excalidrawAPI) return

			const newCollaborators = new Map<string, Collaborator>()

			usersPayload.forEach((payload) => {
				// Use persistent user ID as the key for the map
				newCollaborators.set(payload.user.id, {
					id: payload.user.id,
					username: payload.user.name,
					pointer: payload.pointer,
					button: payload.button,
					selectedElementIds: payload.selectedElementIds,
				})
			})

			excalidrawAPI!.updateScene({ collaborators: newCollaborators })
			console.log(`[Collaboration] Updated collaborators: ${newCollaborators.size} users online`)
		},
		[excalidrawAPI],
	)

	// Function to update cursor state (unthrottled version)
	const doUpdateCursor = useCallback(
		(payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			user: { id: string; name: string }
		}) => {
			if (!excalidrawAPI) return

			try {
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
		[excalidrawAPI],
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
	}, [getJWT, setStatus])

	// Create a debounced version of the room join function to prevent multiple rapid joins
	const debouncedJoinRoom = useMemo(() =>
		debounce((socket: Socket, roomId: string) => {
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

	const handleClientBroadcast = useCallback(
		(data: ArrayBuffer) => {
			try {
				const decoded = JSON.parse(new TextDecoder().decode(data))

				if (!decoded || !decoded.type) {
					console.warn('[Collaboration] Invalid broadcast data:', decoded)
					return
				}

				switch (decoded.type) {
				case BroadcastType.SceneInit:
					if (Array.isArray(decoded.payload?.elements)) {
						reconcileAndApplyRemoteElements(decoded.payload.elements)
					} else {
						console.warn('[Collaboration] Invalid SceneInit payload:', decoded.payload)
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
						handleRemoteImageAdd(decoded.payload.file)
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
		[reconcileAndApplyRemoteElements, updateCursorState, handleRemoteImageAdd, updateViewportState, excalidrawAPI, fileId],
	)

	const handleSyncDesignate = useCallback((data: { isSyncer: boolean }) => {
		console.log(`[Collaboration] Sync designation received: ${data.isSyncer}`)
		setDedicatedSyncer(data.isSyncer)
	}, [setDedicatedSyncer])

	// Handle user joined event - broadcast all images if we're the syncer
	const handleUserJoined = useCallback((data: { userId: string, userName: string, socketId: string, isSyncer: boolean }) => {
		// If we are the syncer, broadcast all our images to the new user
		const { isDedicatedSyncer } = useCollaborationStore.getState()
		if (isDedicatedSyncer && excalidrawAPI) {
			console.log(`[Collaboration] Broadcasting images to new user: ${data.userName}`)

			const files = excalidrawAPI.getFiles()
			const socket = useCollaborationStore.getState().socket

			if (!socket || !socket.connected || !fileId) return

			// Broadcast each image file
			Object.entries(files).forEach(([, file]) => {
				if (file && file.dataURL) {
					const fileData = { type: BroadcastType.ImageAdd, payload: { file } }
					const fileJson = JSON.stringify(fileData)
					const fileBuffer = new TextEncoder().encode(fileJson)
					socket.emit('server-broadcast', `${fileId}`, fileBuffer, [])
				}
			})
		}
	}, [excalidrawAPI, fileId])

	// No custom reconnection strategy needed - socket.io will handle reconnection with Infinity attempts

	// --- Socket Event Handlers Setup ---
	const setupSocketEventHandlers = useCallback(
		(socketInstance: Socket) => {
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
					await handleTokenRefresh()
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
				clearExcalidrawCollaborators()

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
				handleInitRoom()
			})

			socketInstance.on('room-user-change', (data) => {
				console.log(`[Collaboration] Room user change: ${data.length} users`)
				updateCollaboratorsState(data)
			})

			socketInstance.on('client-broadcast', handleClientBroadcast)
			socketInstance.on('sync-designate', handleSyncDesignate)

			socketInstance.on('user-joined', (data) => {
				console.log(`[Collaboration] User joined: ${data.userName} (${data.userId})`)
				handleUserJoined(data)
			})

			// Handle request for presenter's viewport
			socketInstance.on('request-presenter-viewport', async () => {
				console.log('[Collaboration] Presenter viewport requested')

				// Check if we're the presenter
				const { isPresenting } = useCollaborationStore.getState()

				if (isPresenting && excalidrawAPI) {
					const appState = excalidrawAPI.getAppState()
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
					socketInstance.emit('server-broadcast', `${fileId}`, viewportBuffer, [])

					console.log('[Collaboration] Sent presenter viewport:', viewportData.payload)
				}
			})

			// Handle viewport request from another user (for presentation follow)
			socketInstance.on('send-viewport-request', async (data) => {
				const { requesterId } = data
				console.log(`[Collaboration] Viewport requested by user ${requesterId}`)

				// Send our current viewport back to the requester
				if (excalidrawAPI) {
					const appState = excalidrawAPI.getAppState()

					// Check if we're the presenter
					const { isPresenting, presenterId: currentPresenterId } = useCollaborationStore.getState()

					// Use the presenterId if we're presenting, otherwise use JWT userId
					let userId = 'unknown'
					if (isPresenting && currentPresenterId) {
						// If we're presenting, use our presenter ID
						userId = currentPresenterId
					} else {
						// Otherwise get our actual user ID from JWT
						const jwt = await getJWT()
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
					socketInstance.emit('server-broadcast', `${fileId}`, viewportBuffer, [])

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
	const socketInstanceRef = useRef<Socket | null>(null)

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
				socketInstanceRef.current.auth = { token }
				setupSocketEventHandlers(socketInstanceRef.current)
				setSocket(socketInstanceRef.current)

				if (!socketInstanceRef.current.connected) {
					socketInstanceRef.current.connect()
				}
				return
			}

			console.log('[Collaboration] Creating new socket instance')
			const newSocket = io(url.origin, {
				path,
				auth: { token },
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

			// Reset room join tracking
			joinedRoomRef.current = null
		}

		// Also clear the socket instance ref
		socketInstanceRef.current = null
	}, [setSocket, setStatus, clearExcalidrawCollaborators])

	// --- Effects ---
	// Connect/Disconnect based on fileId
	useEffect(() => {
		if (fileId) {
			console.log(`[Collaboration] FileId changed to ${fileId}, connecting socket`)
			connectSocket()
		} else {
			console.log('[Collaboration] No fileId, disconnecting socket')
			disconnectSocket()
		}

		// Cleanup when fileId changes
		return () => {
			// Cancel any pending debounced room joins
			debouncedJoinRoom.cancel()
		}
	}, [fileId, connectSocket, disconnectSocket, debouncedJoinRoom])

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			console.log('[Collaboration] Unmounting, performing full cleanup')

			// Cancel any pending operations
			debouncedJoinRoom.cancel()
			throttledUpdateCursor.cancel()

			// Disconnect socket
			disconnectSocket()

			// Reset store state
			resetStore()
		}
	}, [disconnectSocket, resetStore, throttledUpdateCursor, debouncedJoinRoom])

	// --- Exported Hook API ---
	return {
		connect: connectSocket, // For manual connection control (if needed)
		disconnect: disconnectSocket, // For manual disconnection control
	}
}
