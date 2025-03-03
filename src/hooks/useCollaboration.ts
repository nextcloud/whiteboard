/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
import { useFiles } from './useFiles'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	MouseLocation = 'MOUSE_LOCATION',
}

export function useCollaboration(
	fileId: number,
	publicSharingToken: string | null,
	setViewModeEnabled: (enabled: boolean) => void,
) {
	// External hooks
	const { excalidrawAPI } = useExcalidrawStore()
	const { getJWT } = useJWTStore()
	const { status, setStatus } = useNetworkStore()

	// State and refs
	const [
		lastBroadcastedOrReceivedSceneVersion,
		setLastBroadcastedOrReceivedSceneVersion,
	] = useState(-1)
	const collaboratorsRef = useRef(new Map<string, Collaborator>())
	const filesRef = useRef(new Map<string, BinaryFileData>())
	const socketRef = useRef<Socket | null>(null)

	// Helper functions
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

	// Initialize the files hook
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

	// Socket functions
	const handleConnectionError = useCallback(() => {
		console.warn(
			'Failed to connect to the whiteboard server, switching to offline mode',
		)
		setStatus('offline')
	}, [setStatus])

	const handleTokenRefresh = useCallback(async () => {
		const newToken = await getJWT(`${fileId}`, publicSharingToken)

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

		socket.emit('join-room', `${fileId}`)
		socket.on('joined-data', (data) => {
			const remoteElements = JSON.parse(new TextDecoder().decode(data))
			const reconciledElements = _reconcileElements(remoteElements)
			handleRemoteSceneUpdate(reconciledElements)
			scrollToContent()
		})
		socket.on('image-data', addFile)
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

	// Connect socket
	const connectSocket = useCallback(async () => {
		if (socketRef.current) return

		try {
			setStatus('connecting')

			const collabBackendUrl = loadState(
				'whiteboard',
				'collabBackendUrl',
				'',
			)
			const token = await getJWT(`${fileId}`, publicSharingToken)

			const url = new URL(collabBackendUrl)
			const path = url.pathname.replace(/\/$/, '') + '/socket.io'

			const socket = io(url.origin, {
				path,
				withCredentials: true,
				auth: { token },
				transports: ['websocket'],
				timeout: 10000,
			}).connect()

			socket.on('connect_error', (error) => {
				if (
					error?.message
					&& !error.message.includes('Authentication error')
				) {
					handleConnectionError()
				}
			})

			socket.on('connect_timeout', handleConnectionError)

			// Open socket
			socketRef.current = socket
			setStatus('online')

			socket.on('connect_error', async (error) => {
				if (
					error?.message
					&& error.message.includes('Authentication error')
				) {
					await handleTokenRefresh()
				}
			})

			socket.on('read-only', makeBoardReadOnly)
			socket.on('init-room', handleInitRoom)
			socket.on('room-user-change', updateCollaborators)
			socket.on('client-broadcast', handleClientBroadcast)
		} catch (error) {
			console.error('Failed to connect to socket:', error)
			setStatus('offline')
		}
	}, [
		fileId,
		publicSharingToken,
		getJWT,
		setStatus,
		handleConnectionError,
		handleTokenRefresh,
		makeBoardReadOnly,
		handleInitRoom,
		updateCollaborators,
		handleClientBroadcast,
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

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			disconnectSocket()
		}
	}, [disconnectSocket])

	useEffect(() => {
		if (socketRef.current) {
			// Dispatch event with socket reference for useWhiteboardData
			const event = new CustomEvent('whiteboard-socket-ready', {
				detail: socketRef.current,
			})
			window.dispatchEvent(event)
		}
	}, [socketRef.current])

	return {
		onPointerUpdate,
		onChange,
		scrollToContent,
	}
}
