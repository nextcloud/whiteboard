/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { throttle } from 'lodash'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { t } from '@nextcloud/l10n'
import { useShallow } from 'zustand/react/shallow'
import { broadcastImage } from '../utils/collabServerLimits.ts'
import logger from '../utils/logger'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { BinaryFiles } from '@nextcloud/excalidraw/types'
import type { CollaborationSocket } from '../types/collaboration'
import {
	buildBroadcastedElementVersions,
	computeElementVersionHash,
	getIncrementalSceneElements,
	updateBroadcastedElementVersions,
} from '../utils/syncSceneData'
import type { BroadcastedElementVersions } from '../utils/syncSceneData'
import { getBoardSync } from '../sync/boardSync.ts'
import { changeSet } from '../sync/changes.ts'
import { encodeRoomMessage, sceneMessage } from '../sync/roomMessages.ts'

enum SyncMessageType {
	MouseLocation = 'MOUSE_LOCATION',
	ViewportUpdate = 'VIEWPORT_UPDATE',
	ServerBroadcast = 'server-broadcast',
	ServerVolatileBroadcast = 'server-volatile-broadcast',
}

const WEBSOCKET_SYNC_DELAY = 500
const CURSOR_SYNC_DELAY = 50

// A cheap fingerprint of an image, to send each image once
function hashFileContent(content: string): string {
	if (!content) return ''
	return `${content.length}:${content.substring(0, 20)}:${content.substring(Math.max(0, content.length - 20))}`
}

export function useSync() {
	const { fileId, isReadOnly } = useWhiteboardConfigStore(
		useShallow(state => ({
			fileId: state.fileId,
			isReadOnly: state.isReadOnly,
		})),
	)

	const { excalidrawAPI } = useExcalidrawStore(
		useShallow(state => ({
			excalidrawAPI: state.excalidrawAPI,
		})),
	)

	const { status: collabStatus, socket, isInRoom } = useCollaborationStore(
		useShallow(state => ({
			status: state.status,
			socket: state.socket as CollaborationSocket | null,
			isInRoom: state.isInRoom,
		})),
	)

	const prevSyncedFilesRef = useRef<Record<string, string>>({})
	const lastBroadcastedSceneHashRef = useRef<number | null>(null)
	const broadcastedElementVersionsRef = useRef<BroadcastedElementVersions | null>(null)
	const unsharedFilesRef = useRef(new Set<string>())

	useEffect(() => {
		prevSyncedFilesRef.current = {}
		lastBroadcastedSceneHashRef.current = null
		broadcastedElementVersionsRef.current = null
	}, [fileId, socket?.id, isInRoom])

	useEffect(() => {
		unsharedFilesRef.current = new Set()
	}, [fileId])

	const broadcastChanges = useCallback((payload: object) => {
		if (!socket || !fileId) {
			return
		}
		socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, encodeRoomMessage(sceneMessage(getBoardSync()?.epoch, payload)), [])
	}, [socket, fileId])

	// Sends the elements and images that changed since the last broadcast. The
	// first broadcast after joining sends this tab's unsaved changes: the room
	// has the rest from Nextcloud.
	const doSyncViaWebSocket = useCallback(() => {
		if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online' || isReadOnly || !isInRoom) {
			return
		}

		try {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[]
			const sceneHash = computeElementVersionHash(elements)
			let changed: readonly ExcalidrawElement[]
			let files: BinaryFiles
			if (broadcastedElementVersionsRef.current === null) {
				const unsaved = getBoardSync()?.unsavedChanges() ?? changeSet()
				changed = unsaved.elements
				files = unsaved.files
				broadcastedElementVersionsRef.current = buildBroadcastedElementVersions(elements)
				// The room gets the other images from Nextcloud
				prevSyncedFilesRef.current = Object.fromEntries(Object.entries(excalidrawAPI.getFiles())
					.filter(([id]) => !files[id])
					.map(([id, file]) => [id, hashFileContent(file?.dataURL ?? '')]))
			} else if (lastBroadcastedSceneHashRef.current !== sceneHash) {
				changed = getIncrementalSceneElements(elements, broadcastedElementVersionsRef.current)
				broadcastedElementVersionsRef.current = updateBroadcastedElementVersions(broadcastedElementVersionsRef.current, changed)
				files = excalidrawAPI.getFiles()
			} else {
				changed = []
				files = excalidrawAPI.getFiles()
			}
			lastBroadcastedSceneHashRef.current = sceneHash

			if (changed.length > 0) {
				broadcastChanges({ elements: changed })
			}
			for (const [id, file] of Object.entries(files)) {
				const hash = hashFileContent(file?.dataURL ?? '')
				if (!file?.dataURL || prevSyncedFilesRef.current[id] === hash) {
					continue
				}
				// A file the server refuses is tried again, for example after a reconnect to a node that accepts it
				if (broadcastImage(socket, `${fileId}`, file)) {
					prevSyncedFilesRef.current[id] = hash
				} else if (!unsharedFilesRef.current.has(id)) {
					unsharedFilesRef.current.add(id)
					logger.warn(`[Sync] Image ${id} is too large to share`)
					excalidrawAPI.setToast({
						message: t('whiteboard', 'This image is too large to share with others'),
						closable: true,
						duration: 5000,
					})
				}
			}
		} catch (error) {
			logger.error('[Sync] WebSocket sync failed:', error)
		}
	}, [fileId, excalidrawAPI, socket, collabStatus, isReadOnly, isInRoom, broadcastChanges])

	const throttledSyncViaWebSocket = useMemo(() =>
		throttle(doSyncViaWebSocket, WEBSOCKET_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncViaWebSocket])

	useEffect(() => {
		if (isInRoom && fileId && socket && collabStatus === 'online' && !isReadOnly) {
			throttledSyncViaWebSocket()
		}
	}, [isInRoom, fileId, socket, collabStatus, isReadOnly, throttledSyncViaWebSocket])

	// --- Cursor Sync ---
	const doSyncCursors = useCallback(
		(payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
		}) => {
			if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online') {
				return
			}

			try {
				const data = {
					type: SyncMessageType.MouseLocation,
					payload: {
						pointer: payload.pointer,
						button: payload.button,
						selectedElementIds: excalidrawAPI.getAppState().selectedElementIds,
					},
				}
				socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, new TextEncoder().encode(JSON.stringify(data)))
			} catch (error) {
				logger.error('[Sync] Error syncing cursor:', error)
			}
		},
		[fileId, excalidrawAPI, socket, collabStatus],
	)

	// --- Viewport Sync ---
	const lastBroadcastedViewportRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 })

	const doSyncViewport = useCallback(
		async (appState: { scrollX: number; scrollY: number; zoom: { value: number } }) => {
			if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online') {
				return
			}

			const { scrollX, scrollY, zoom } = appState
			const lastViewport = lastBroadcastedViewportRef.current

			// Only broadcast if viewport has changed significantly
			if (
				Math.abs(scrollX - lastViewport.scrollX) > 5
				|| Math.abs(scrollY - lastViewport.scrollY) > 5
				|| Math.abs(zoom.value - lastViewport.zoom) > 0.01
			) {
				try {
					const { getJWT, parseJwt } = useJWTStore.getState()
					const jwt = await getJWT()
					const jwtPayload = jwt ? parseJwt(jwt) : null
					const userId = jwtPayload?.userid || 'unknown'

					const data = {
						type: SyncMessageType.ViewportUpdate,
						payload: {
							userId,
							scrollX,
							scrollY,
							zoom: zoom.value,
						},
					}
					socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, new TextEncoder().encode(JSON.stringify(data)))

					lastBroadcastedViewportRef.current = { scrollX, scrollY, zoom: zoom.value }
				} catch (error) {
					console.error('[Sync] Error syncing viewport:', error)
				}
			}
		},
		[fileId, excalidrawAPI, socket, collabStatus],
	)

	const throttledSyncCursors = useMemo(() =>
		throttle(doSyncCursors, CURSOR_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncCursors])

	const throttledSyncViewport = useMemo(() =>
		throttle(doSyncViewport, CURSOR_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncViewport])

	// --- Event Handlers ---
	const onChange = useCallback(() => {
		getBoardSync()?.changed()
		throttledSyncViaWebSocket()
		if (excalidrawAPI) {
			throttledSyncViewport(excalidrawAPI.getAppState())
		}
	}, [throttledSyncViaWebSocket, throttledSyncViewport, excalidrawAPI])

	const onPointerUpdate = useCallback(
		(payload: {
			pointersMap: Map<string, { x: number; y: number }>,
			pointer: { x: number; y: number; tool: 'laser' | 'pointer' },
			button: 'down' | 'up'
		}) => {
			if (payload.pointersMap.size < 2) {
				throttledSyncCursors({ pointer: payload.pointer, button: payload.button })
			}
		},
		[throttledSyncCursors],
	)

	useEffect(() => {
		const handlePageHide = () => {
			throttledSyncViaWebSocket.flush()
		}
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				throttledSyncViaWebSocket.flush()
				getBoardSync()?.hidden()
			} else {
				void getBoardSync()?.fetch()
			}
		}
		const handleOnline = () => {
			void getBoardSync()?.fetch()
			void getBoardSync()?.save()
		}

		window.addEventListener('pagehide', handlePageHide)
		window.addEventListener('beforeunload', handlePageHide)
		window.addEventListener('online', handleOnline)
		document.addEventListener('visibilitychange', handleVisibilityChange)

		return () => {
			window.removeEventListener('pagehide', handlePageHide)
			window.removeEventListener('beforeunload', handlePageHide)
			window.removeEventListener('online', handleOnline)
			document.removeEventListener('visibilitychange', handleVisibilityChange)
			throttledSyncViaWebSocket.flush()
			throttledSyncViaWebSocket.cancel()
			throttledSyncCursors.cancel()
			throttledSyncViewport.cancel()
		}
	}, [throttledSyncViaWebSocket, throttledSyncCursors, throttledSyncViewport])

	return { onChange, onPointerUpdate }
}
