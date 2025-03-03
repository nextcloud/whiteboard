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

export function useCollaboration(
	setViewModeEnabled: (enabled: boolean) => void,
) {
	const { excalidrawAPI } = useExcalidrawStore()
	const { getJWT } = useJWTStore()
	const { status, setStatus } = useNetworkStore()
	const { fileId, publicSharingToken } = useWhiteboardStore()

	const [
		lastBroadcastedOrReceivedSceneVersion,
		setLastBroadcastedOrReceivedSceneVersion,
	] = useState(-1)
	const collaboratorsRef = useRef(new Map<string, Collaborator>())
	const filesRef = useRef(new Map<string, BinaryFileData>())
	const socketRef = useRef<Socket | null>(null)
	const wasConnectedBeforeRef = useRef(false)

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

	const makeBoardReadOnly = useCallback(() => {
		setViewModeEnabled(true)
	}, [setViewModeEnabled])

	const sendImageFiles = useCallback(
		async (files: BinaryFiles) => {
			if (!socketRef.current) return

			Object.values(files).forEach((file) => {
				addFile(file)
				socketRef.current?.emit('image-add', `${fileId}`, file.id, file)
			})
		},
		[fileId],
	)

	const { addFile } = useFiles(sendImageFiles)

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

			excalidrawAPI.updateScene({ collaborators })
			collaboratorsRef.current = collaborators
		},
		[excalidrawAPI],
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

	const handleConnectionError = useCallback(() => {
		console.warn(
			'Failed to connect to the whiteboard server, switching to offline mode',
		)
		setStatus('offline')
	}, [setStatus])

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
			socket.on('image-data', addFile)
		}
	}, [
		fileId,
		_reconcileElements,
		handleRemoteSceneUpdate,
		scrollToContent,
		addFile,
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

	const syncFiles = useCallback(
		(files: BinaryFiles) => {
			const syncedFiles = Array.from(filesRef.current.keys())
			const newFiles = Object.keys(files)
				.filter((id) => !syncedFiles.includes(id))
				.reduce((acc, id) => {
					acc[id] = files[id]
					return acc
				}, {} as BinaryFiles)

			if (Object.keys(newFiles).length > 0) {
				sendImageFiles(newFiles)
			}
		},
		[sendImageFiles],
	)

	const setupSocketEventHandlers = useCallback(
		(socket: Socket) => {
			// Remove any existing listeners to prevent duplicates
			socket.off('connect_error')
			socket.off('connect_timeout')
			socket.off('connect')
			socket.off('disconnect')
			socket.off('read-only')
			socket.off('init-room')
			socket.off('room-user-change')
			socket.off('client-broadcast')

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

				if (
					reason === 'io server disconnect'
					|| reason === 'io client disconnect'
				) {
					setStatus('offline')
				} else {
					setStatus('offline')
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
			socket.on('read-only', makeBoardReadOnly)
			socket.on('init-room', handleInitRoom)
			socket.on('room-user-change', updateCollaborators)
			socket.on('client-broadcast', handleClientBroadcast)

			return socket
		},
		[
			handleConnectionError,
			setStatus,
			handleInitRoom,
			handleTokenRefresh,
			makeBoardReadOnly,
			updateCollaborators,
			handleClientBroadcast,
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
		} catch (error) {
			console.error('[Collaboration] Failed to connect to socket:', error)
			setStatus('offline')
		}
	}, [
		fileId,
		publicSharingToken,
		getJWT,
		setStatus,
		setupSocketEventHandlers,
	])

	const disconnectSocket = useCallback(() => {
		if (socketRef.current) {
			socketRef.current.disconnect()
			socketRef.current = null
		}
	}, [])

	// Excalidraw onChange handler
	const onChange = useCallback(
		throttle(
			(
				elements: readonly ExcalidrawElement[],
				_state: AppState,
				files: BinaryFiles,
			) => {
				if (!excalidrawAPI) return

				const elementsVersion = hashElementsVersion(elements)
				if (elementsVersion > lastBroadcastedOrReceivedSceneVersion) {
					setLastBroadcastedOrReceivedSceneVersion(elementsVersion)

					if (status === 'online') {
						broadcastScene(
							BroadcastType.SceneInit,
							Object.values(getSceneElementsIncludingDeleted()),
						)
					}

					syncFiles(files)
				}
			},
			300,
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

	useEffect(() => {
		if (excalidrawAPI && !socketRef.current) {
			// Add delay to avoid blocking initial render
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
			disconnectSocket()
		}
	}, [disconnectSocket])

	useEffect(() => {
		if (socketRef.current) {
			// Dispatch an event that other components can listen for
			console.log('[Collaboration] Dispatching socket-ready event')

			const socketReadyEvent = new CustomEvent(
				'whiteboard-socket-ready',
				{
					detail: socketRef.current,
					bubbles: true,
				},
			)

			document.dispatchEvent(socketReadyEvent)
		}
	}, [socketRef.current])

	return {
		onPointerUpdate,
		onChange,
		scrollToContent,
		isConnected: status === 'online',
	}
}
