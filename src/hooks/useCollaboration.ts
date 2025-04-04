/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type {
	AppState,
	BinaryFileData,
	BinaryFiles,
	Collaborator,
	Gesture,
} from '@excalidraw/excalidraw/types/types'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'
import { hashElementsVersion, reconcileElements } from '../util'
import { io, type Socket } from 'socket.io-client'
import { loadState } from '@nextcloud/initial-state'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useNetworkStore } from '../stores/useNetworkStore'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { useFiles } from './useFiles'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	MouseLocation = 'MOUSE_LOCATION',
}

export function useCollaboration() {
	const { excalidrawAPI } = useExcalidrawStore()
	const { getJWT } = useJWTStore()
	const {
		status,
		setStatus,
		setLastConnected,
		incrementReconnectAttempts,
		resetReconnectAttempts,
		setCollaborators,
		clearCollaborators,
		reconnectAttempts,
	} = useNetworkStore()
	const { fileId, publicSharingToken, setReadOnly, setDedicatedSyncer, setSocketRef } = useWhiteboardStore()

	const [
		lastBroadcastedOrReceivedSceneVersion,
		setLastBroadcastedOrReceivedSceneVersion,
	] = useState(-1)
	const collaboratorsRef = useRef(new Map<string, Collaborator>())
	const filesRef = useRef(new Map<string, BinaryFileData>())
	const socketRef = useRef<Socket | null>(null)
	const wasConnectedBeforeRef = useRef(false)
	const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null)

	const getSceneElementsIncludingDeleted = useCallback(() => {
		return excalidrawAPI?.getSceneElementsIncludingDeleted() || []
	}, [excalidrawAPI])

	const handleRemoteSceneUpdate = useCallback(
		(elements: ExcalidrawElement[]) => {
			excalidrawAPI?.updateScene({ elements })
		},
		[excalidrawAPI],
	)

	const _reconcileElements = useCallback(
		(remoteElements: readonly ExcalidrawElement[]) => {
			if (!excalidrawAPI) return []

			const restoredRemoteElements = restoreElements(remoteElements, null)
			const localElements = getSceneElementsIncludingDeleted()
			const appState = excalidrawAPI.getAppState()

			return reconcileElements(
				localElements,
				restoredRemoteElements,
				appState,
			)
		},
		[excalidrawAPI, getSceneElementsIncludingDeleted],
	)

	const scrollToContent = useCallback(() => {
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElements()
		excalidrawAPI.scrollToContent(elements, {
			fitToContent: true,
			animate: true,
			duration: 500,
		})
	}, [excalidrawAPI])

	// Update read-only state based on JWT
	const updateReadOnlyState = useCallback((isReadOnly: boolean) => {
		// Only set the read-only state in the store
		// The store will handle enabling view mode if needed
		setReadOnly(isReadOnly)
		console.log(`[Permissions] User has ${isReadOnly ? 'read-only' : 'write'} access`)
	}, [setReadOnly])

	const sendImageFilesRef = useRef(() => {
		return Promise.resolve()
	})

	const sendImageFiles = useCallback(
		async (files: BinaryFiles) => {
			if (!socketRef.current) return

			Object.values(files).forEach((file) => {
				try {
					// First add the file locally using the current addFile function
					if (addFileRef.current) {
						try {
							addFileRef.current(file)
						} catch (error) {
							console.error('[Collaboration] Error processing image:', error)
						}
					}

					// Then broadcast to other users
					socketRef.current?.emit('image-add', `${fileId}`, file.id, file)
					console.log(`[Collaboration] Sent image ${file.id} to room`)
				} catch (error) {
					console.error(`[Collaboration] Error processing/sending image ${file.id}:`, error)
				}
			})
		},
		[fileId],
	)

	// Update the ref when the function changes
	useEffect(() => {
		sendImageFilesRef.current = sendImageFiles
	}, [sendImageFiles])

	// Get the addFile function from useFiles with proper typing
	const { addFile } = useFiles(useCallback((files: BinaryFiles) => sendImageFilesRef.current(files), []))

	// Create a ref to store the addFile function
	const addFileRef = useRef<(file: BinaryFileData) => void>()

	// Update the ref when addFile changes
	useEffect(() => {
		addFileRef.current = addFile
	}, [addFile])

	// Wrap addFile in a try-catch to handle any image processing errors
	const safeAddFile = useCallback((file: BinaryFileData) => {
		try {
			if (addFileRef.current) {
				addFileRef.current(file)
			}
		} catch (error) {
			console.error('[Collaboration] Error processing image:', error)
		}
	}, [])

	const updateCollaborators = useCallback(
		(
			users: {
				user: {
					id: string
					name: string
				}
				socketId: string
				pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
				button: 'down' | 'up'
				selectedElementIds: AppState['selectedElementIds']
			}[],
		) => {
			if (!excalidrawAPI) return

			const collaborators = new Map<string, Collaborator>()

			users.forEach((payload) => {
				collaborators.set(payload.user.id, {
					username: payload.user.name,
					...payload,
				})
			})

			// Update Excalidraw scene with collaborators
			excalidrawAPI.updateScene({ collaborators })

			// Store collaborators in local ref and in NetworkStore
			collaboratorsRef.current = collaborators
			setCollaborators(collaborators)

			// Log collaborator count
			console.log(`[Collaboration] Updated collaborators: ${collaborators.size} users online`)
		},
		[excalidrawAPI, setCollaborators],
	)

	const updateCursor = useCallback(
		(payload: {
			socketId: string
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			selectedElementIds: AppState['selectedElementIds']
			user: {
				id: string
				name: string
			}
		}) => {
			if (!excalidrawAPI) return

			const updatedCollaborators = new Map(collaboratorsRef.current)
			updatedCollaborators.set(payload.user.id, {
				...collaboratorsRef.current.get(payload.user.id),
				...payload,
				username: payload.user.name,
			})

			excalidrawAPI.updateScene({ collaborators: updatedCollaborators })
			collaboratorsRef.current = updatedCollaborators
		},
		[excalidrawAPI],
	)

	// Forward declarations to avoid circular dependencies
	const connectSocketRef = useRef(() => Promise.resolve())

	// Calculate reconnection delay with exponential backoff
	const getReconnectDelay = useCallback(() => {
		// Start with 1 second, then 2, 4, 8, 16, etc. up to 30 seconds max
		const baseDelay = 1000
		const maxDelay = 30000
		const delay = Math.min(maxDelay, baseDelay * Math.pow(2, reconnectAttempts))

		// Add some randomness to prevent all clients reconnecting simultaneously
		return delay + (Math.random() * 1000)
	}, [reconnectAttempts])

	// Clear collaborators from Excalidraw scene
	const clearExcalidrawCollaborators = useCallback(() => {
		if (!excalidrawAPI) return

		console.log('[Collaboration] Clearing collaborators from Excalidraw scene')

		// Clear collaborators in Excalidraw scene
		excalidrawAPI.updateScene({ collaborators: new Map() })

		// Clear local collaborators reference
		collaboratorsRef.current = new Map()

		// Clear collaborators in NetworkStore
		clearCollaborators()
	}, [excalidrawAPI, clearCollaborators])

	// Handle connection errors and schedule reconnection attempts
	const handleConnectionError = useCallback(() => {
		console.warn('[Collaboration] Failed to connect to the whiteboard server')

		// Set status to offline and clear collaborators
		setStatus('offline')
		clearExcalidrawCollaborators()

		// Clear any existing reconnection timer
		if (reconnectTimerRef.current) {
			clearTimeout(reconnectTimerRef.current)
			reconnectTimerRef.current = null
		}

		// Schedule reconnection attempt with exponential backoff
		const delay = getReconnectDelay()
		console.log(`[Collaboration] Scheduling reconnection attempt in ${Math.round(delay / 1000)} seconds`)

		setStatus('reconnecting')
		incrementReconnectAttempts()

		reconnectTimerRef.current = setTimeout(() => {
			console.log('[Collaboration] Attempting to reconnect...')
			connectSocketRef.current()
		}, delay)
	}, [setStatus, clearExcalidrawCollaborators, getReconnectDelay, incrementReconnectAttempts])

	const handleTokenRefresh = useCallback(async () => {
		const newToken = await getJWT()

		if (socketRef.current && newToken) {
			socketRef.current.auth = { token: newToken }
			socketRef.current.connect()
		} else {
			setStatus('offline')
		}
	}, [fileId, publicSharingToken, getJWT, setStatus])

	const handleInitRoom = useCallback(() => {
		const socket = socketRef.current
		if (!socket) return

		console.log(`[Collaboration] Joining room ${fileId}`)
		socket.emit('join-room', `${fileId}`)
		if (!socket.hasListeners('image-data')) {
			socket.on('image-data', safeAddFile)
		}
	}, [
		fileId,
		_reconcileElements,
		handleRemoteSceneUpdate,
		scrollToContent,
		safeAddFile,
	])

	const handleClientBroadcast = useCallback(
		(data: ArrayBuffer) => {
			const decoded = JSON.parse(new TextDecoder().decode(data))
			switch (decoded.type) {
			case BroadcastType.SceneInit: {
				const reconciledElements = _reconcileElements(
					decoded.payload.elements,
				)
				handleRemoteSceneUpdate(reconciledElements)
				break
			}
			case BroadcastType.MouseLocation:
				updateCursor(decoded.payload)
				break
			}
		},
		[_reconcileElements, handleRemoteSceneUpdate, updateCursor],
	)

	const broadcastSocketData = useCallback(
		async (
			data: {
				type: string
				payload: {
					elements?: readonly ExcalidrawElement[]
					socketId?: string
					pointer?: {
						x: number
						y: number
						tool: 'pointer' | 'laser'
					}
					button?: 'down' | 'up'
					selectedElementIds?: AppState['selectedElementIds']
					username?: string
				}
			},
			volatile: boolean = false,
			targetRoomId?: string,
		) => {
			if (!socketRef.current) return

			const json = JSON.stringify(data)
			const encryptedBuffer = new TextEncoder().encode(json)
			socketRef.current.emit(
				volatile ? 'server-volatile-broadcast' : 'server-broadcast',
				targetRoomId ?? `${fileId}`,
				encryptedBuffer,
				[],
			)
		},
		[fileId],
	)

	const broadcastScene = useCallback(
		async (updateType: string, elements: readonly ExcalidrawElement[]) => {
			await broadcastSocketData({
				type: updateType,
				payload: { elements },
			})
		},
		[broadcastSocketData],
	)

	const broadcastMouseLocation = useCallback(
		async (payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
			pointersMap: Gesture['pointers']
		}) => {
			if (!excalidrawAPI) return

			const data = {
				type: BroadcastType.MouseLocation,
				payload: {
					socketId: socketRef.current?.id,
					pointer: payload.pointer,
					button: payload.button || 'up',
					selectedElementIds:
						excalidrawAPI.getAppState().selectedElementIds,
					username: socketRef.current?.id,
				},
			}

			await broadcastSocketData(data, true)
		},
		[excalidrawAPI, broadcastSocketData],
	)

	// Track the last synced files to prevent unnecessary updates
	const lastSyncedFilesRef = useRef<Record<string, string>>({}) // fileId -> hash
	// Track the previous files for comparison
	const prevFilesRef = useRef<BinaryFiles>({})

	// Generate a simple hash for a file to detect changes
	const getFileHash = useCallback((file: BinaryFileData): string => {
		// Use created timestamp and first 100 chars of dataURL as a simple hash
		const dataURLPrefix = file.dataURL?.substring(0, 100) || ''
		return `${file.created}-${dataURLPrefix.length}`
	}, [])

	// Function to check if files have changed
	const haveFilesChanged = useCallback((oldFiles: BinaryFiles, newFiles: BinaryFiles) => {
		// Quick check for different keys
		const oldKeys = Object.keys(oldFiles)
		const newKeys = Object.keys(newFiles)

		if (oldKeys.length !== newKeys.length) {
			return true
		}

		// Check if any keys are different
		for (const key of newKeys) {
			if (!oldFiles[key]) {
				return true
			}
		}

		// Files are the same
		return false
	}, [])

	// Enhanced file syncing that only syncs new or changed files
	const syncFiles = useCallback(
		(files: BinaryFiles) => {
			// First check if files have actually changed from previous sync
			if (!haveFilesChanged(prevFilesRef.current, files)) {
				console.log('[Collaboration] Files unchanged since last sync, skipping')
				return
			}

			// Update our reference for next comparison
			prevFilesRef.current = { ...files }

			const syncedFiles = Array.from(filesRef.current.keys())
			const newOrChangedFiles: BinaryFiles = {}

			// Check for new or changed files
			Object.entries(files).forEach(([id, file]) => {
				const fileHash = getFileHash(file)

				// If file is new or has changed, add it to the sync list
				if (!syncedFiles.includes(id) || lastSyncedFilesRef.current[id] !== fileHash) {
					newOrChangedFiles[id] = file

					// Update the hash in our tracking ref
					lastSyncedFilesRef.current[id] = fileHash
				}
			})

			// Only send files if there are new or changed ones
			if (Object.keys(newOrChangedFiles).length > 0) {
				console.log(`[Collaboration] Syncing ${Object.keys(newOrChangedFiles).length} new or changed files`)
				sendImageFiles(newOrChangedFiles)
			}
		},
		[sendImageFiles, getFileHash, haveFilesChanged],
	)

	const handleSyncDesignate = useCallback((data: { isSyncer: boolean }) => {
		setDedicatedSyncer(data.isSyncer)
	}, [setDedicatedSyncer])

	/**
	 * Handle when a new user joins the room
	 * If this client is the syncer, it will broadcast the current scene to all users
	 */
	const handleUserJoined = useCallback((data: { userId: string, userName: string, socketId: string, isSyncer: boolean }) => {
		if (!excalidrawAPI || !socketRef.current) return

		// Check if this client is the syncer
		const { isDedicatedSyncer } = useWhiteboardStore.getState()
		if (!isDedicatedSyncer) {
			console.log(`[Collaboration] New user joined: ${data.userName} (${data.userId}). They ${data.isSyncer ? 'are' : 'are not'} the syncer.`)
			return
		}

		console.log(`[Collaboration] New user joined: ${data.userName} (${data.userId}). Broadcasting current scene as syncer.`)

		// Get current scene elements and files
		const elements = Object.values(getSceneElementsIncludingDeleted())
		const files = excalidrawAPI.getFiles()

		// Broadcast the current scene to all users
		broadcastScene(BroadcastType.SceneInit, elements)

		// Also sync any files/images
		Object.values(files).forEach(file => {
			if (file.dataURL) {
				try {
					// Send the file directly - this matches what the server expects
					socketRef.current?.emit('image-add', `${fileId}`, file.id, file)
					console.log(`[Collaboration] Sent image ${file.id} to new user`)
				} catch (error) {
					console.error(`[Collaboration] Error sending image ${file.id}:`, error)
				}
			}
		})

		console.log(`[Collaboration] Broadcast complete: ${elements.length} elements and ${Object.keys(files).length} files`)
	}, [excalidrawAPI, fileId, getSceneElementsIncludingDeleted, broadcastScene])

	const setupSocketEventHandlers = useCallback(
		(socket: Socket) => {
			// Remove any existing listeners to prevent duplicates
			socket.off('connect_error')
			socket.off('connect_timeout')
			socket.off('connect')
			socket.off('disconnect')
			// Note: 'read-only' event is no longer used
			socket.off('init-room')
			socket.off('room-user-change')
			socket.off('client-broadcast')
			socket.off('sync-designate')
			socket.off('user-joined')

			// Basic connection events
			socket.on('connect_error', (error) => {
				if (
					error?.message
					&& !error.message.includes('Authentication error')
				) {
					handleConnectionError()
				}
			})

			socket.on('connect_timeout', handleConnectionError)

			socket.on('connect', () => {
				console.log(
					'[Collaboration] Successfully connected to the websocket server',
				)
				setStatus('online')

				// Reset reconnection attempts counter on successful connection
				resetReconnectAttempts()

				// Update last connected timestamp
				setLastConnected(Date.now())

				// If we were previously connected and then reconnected, we need to re-join the room
				if (wasConnectedBeforeRef.current) {
					console.log(
						'[Collaboration] Reconnected after disconnect, re-joining room',
					)
					// Small delay to ensure the server is ready to process our room join
					setTimeout(() => {
						handleInitRoom()
					}, 500)
				}

				wasConnectedBeforeRef.current = true
			})

			socket.on('disconnect', (reason) => {
				console.log(
					`[Collaboration] Disconnected from websocket server: ${reason}`,
				)

				// Clear collaborators from Excalidraw scene
				clearExcalidrawCollaborators()

				if (
					// Intentional disconnects - don't attempt to reconnect
					reason === 'io server disconnect'
					|| reason === 'io client disconnect'
				) {
					setStatus('offline')
				} else {
					// Unintentional disconnects - attempt to reconnect
					console.log('[Collaboration] Unexpected disconnect, will attempt to reconnect')
					handleConnectionError()
				}
			})

			socket.on('connect_error', async (error) => {
				if (
					error?.message
					&& error.message.includes('Authentication error')
				) {
					await handleTokenRefresh()
				}
			})

			// Whiteboard-specific events
			// Note: 'read-only' event is no longer used, we check JWT directly
			socket.on('init-room', handleInitRoom)
			socket.on('room-user-change', updateCollaborators)
			socket.on('client-broadcast', handleClientBroadcast)
			socket.on('sync-designate', handleSyncDesignate)
			socket.on('user-joined', handleUserJoined)

			return socket
		},
		[
			handleConnectionError,
			setStatus,
			handleInitRoom,
			handleTokenRefresh,
			updateCollaborators,
			handleClientBroadcast,
			handleSyncDesignate,
			handleUserJoined,
			clearExcalidrawCollaborators,
			resetReconnectAttempts,
			setLastConnected,
		],
	)

	// Connect socket
	const connectSocket = useCallback(async () => {
		if (socketRef.current) {
			// If there's an existing socket, disconnect it first
			socketRef.current.disconnect()
			socketRef.current = null
		}

		try {
			setStatus('connecting')

			const collabBackendUrl = loadState(
				'whiteboard',
				'collabBackendUrl',
				'',
			)
			const token = await getJWT()

			// Check if the JWT token indicates read-only access
			if (token) {
				const parsedToken = useJWTStore.getState().parseJwt(token)
				if (parsedToken) {
					console.log(`[Collaboration] JWT indicates ${parsedToken.isFileReadOnly ? 'read-only' : 'write'} access`)
					// Update read-only state based on JWT
					updateReadOnlyState(parsedToken.isFileReadOnly)
				}
			}

			const url = new URL(collabBackendUrl)
			const path = url.pathname.replace(/\/$/, '') + '/socket.io'

			const socket = io(url.origin, {
				path,
				withCredentials: true,
				auth: { token },
				transports: ['websocket'],
				timeout: 10000,
			}).connect()

			// Set up all event handlers
			setupSocketEventHandlers(socket)

			// Store socket reference
			socketRef.current = socket

			// Share socket with WhiteboardStore
			setSocketRef(socket)
		} catch (error) {
			console.error('[Collaboration] Failed to connect to socket:', error)
			// Trigger reconnection logic
			handleConnectionError()
		}
	}, [
		fileId,
		publicSharingToken,
		getJWT,
		setStatus,
		setupSocketEventHandlers,
		setSocketRef,
		updateReadOnlyState,
		handleConnectionError,
	])

	// Update the connectSocket ref when the function changes
	useEffect(() => {
		connectSocketRef.current = connectSocket
	}, [connectSocket])

	const disconnectSocket = useCallback(() => {
		if (socketRef.current) {
			socketRef.current.disconnect()
			socketRef.current = null
		}
	}, [])

	// Track the last elements version to prevent unnecessary updates
	const lastElementsVersionRef = useRef<number>(-1)

	// Track the last files sync timestamp
	const lastFilesSyncTimestampRef = useRef<number>(0)

	// Excalidraw onChange handler with optimized image handling
	const onChange = useCallback(
		throttle(
			(
				elements: readonly ExcalidrawElement[],
				_state: AppState,
				files: BinaryFiles,
			) => {
				if (!excalidrawAPI) return

				// Calculate hash of current elements
				const elementsVersion = hashElementsVersion(elements)
				const now = Date.now()

				// Only broadcast elements if they've changed
				if (elementsVersion > lastBroadcastedOrReceivedSceneVersion) {
					setLastBroadcastedOrReceivedSceneVersion(elementsVersion)
					lastElementsVersionRef.current = elementsVersion

					// Broadcast scene changes if online
					if (status === 'online') {
						broadcastScene(
							BroadcastType.SceneInit,
							Object.values(getSceneElementsIncludingDeleted()),
						)
					}
				}

				// Sync files less frequently to prevent image blinking
				// Only sync files every 2 seconds at most, unless elements have changed
				const shouldSyncFiles
					// Always sync if elements changed significantly
					= elementsVersion > lastElementsVersionRef.current
					// Otherwise, only sync every 2 seconds
					|| (now - lastFilesSyncTimestampRef.current > 2000)

				if (shouldSyncFiles && Object.keys(files).length > 0) {
					syncFiles(files)
					lastFilesSyncTimestampRef.current = now
				}
			},
			300, // Throttle to 300ms
		),
		[
			excalidrawAPI,
			status,
			lastBroadcastedOrReceivedSceneVersion,
			getSceneElementsIncludingDeleted,
			broadcastScene,
			syncFiles,
		],
	)

	// Pointer update handler
	const onPointerUpdate = useCallback(
		throttle(
			(payload: {
				pointersMap: Gesture['pointers']
				pointer: { x: number; y: number; tool: 'laser' | 'pointer' }
				button: 'down' | 'up'
			}) => {
				if (
					status === 'online'
					&& payload.pointersMap.size < 2
					&& socketRef.current
				) {
					broadcastMouseLocation(payload)
				}
			},
			100,
		),
		[status, broadcastMouseLocation],
	)

	// Monitor connection status and clear collaborators if offline for too long
	useEffect(() => {
		// If status changes to offline, set a timer to clear collaborators
		if (status === 'offline' && excalidrawAPI) {
			// Clear collaborators immediately to ensure UI is updated
			clearExcalidrawCollaborators()
		}
	}, [status, excalidrawAPI, clearExcalidrawCollaborators])

	useEffect(() => {
		if (excalidrawAPI && !socketRef.current) {
			const timer = setTimeout(() => {
				connectSocket()
			}, 800)
			return () => clearTimeout(timer)
		}
	}, [excalidrawAPI, connectSocket])

	// Broadcast current scene after reconnecting to ensure all clients are in sync
	useEffect(() => {
		if (
			status === 'online'
			&& excalidrawAPI
			&& wasConnectedBeforeRef.current
		) {
			// Small delay to ensure socket events are properly set up
			const timer = setTimeout(() => {
				console.log(
					'[Collaboration] Broadcasting current scene after reconnect',
				)
				broadcastScene(
					BroadcastType.SceneInit,
					Object.values(getSceneElementsIncludingDeleted()),
				)
			}, 1500)

			return () => clearTimeout(timer)
		}
	}, [
		status,
		excalidrawAPI,
		broadcastScene,
		getSceneElementsIncludingDeleted,
	])

	useEffect(() => {
		return () => {
			// Disconnect socket
			disconnectSocket()

			// Clear any reconnection timer
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
				reconnectTimerRef.current = null
			}

			// Make sure collaborators are cleared when component unmounts
			if (excalidrawAPI) {
				excalidrawAPI.updateScene({ collaborators: new Map() })
			}
		}
	}, [disconnectSocket, excalidrawAPI])

	return {
		onPointerUpdate,
		onChange,
		scrollToContent,
		isConnected: status === 'online',
	}
}
