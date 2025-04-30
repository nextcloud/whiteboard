/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { throttle } from 'lodash'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { useSyncStore, logSyncResult } from '../stores/useSyncStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
// @ts-expect-error - Type definitions issue with @nextcloud/router
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'

enum SyncMessageType {
	SceneInit = 'SCENE_INIT',
	ImageAdd = 'IMAGE_ADD',
	MouseLocation = 'MOUSE_LOCATION',
	ServerBroadcast = 'server-broadcast',
	ServerVolatileBroadcast = 'server-volatile-broadcast',
}

const LOCAL_SYNC_DELAY = 1000
const SERVER_API_SYNC_DELAY = 60000
const WEBSOCKET_SYNC_DELAY = 500
const CURSOR_SYNC_DELAY = 50

export function useSync() {
	const { fileId, isReadOnly } = useWhiteboardStore(
		useShallow(state => ({
			fileId: state.fileId,
			isReadOnly: state.isReadOnly,
		})),
	)

	const {
		initializeWorker,
		terminateWorker,
		isWorkerReady,
		worker,
	} = useSyncStore(
		useShallow(state => ({
			initializeWorker: state.initializeWorker,
			terminateWorker: state.terminateWorker,
			isWorkerReady: state.isWorkerReady,
			worker: state.worker,
		})),
	)

	const { getJWT } = useJWTStore(
		useShallow(state => ({
			getJWT: state.getJWT,
		})),
	)

	const { excalidrawAPI } = useExcalidrawStore(
		useShallow(state => ({
			excalidrawAPI: state.excalidrawAPI,
		})),
	)

	const { isDedicatedSyncer, status: collabStatus, socket } = useCollaborationStore(
		useShallow(state => ({
			isDedicatedSyncer: state.isDedicatedSyncer,
			status: state.status,
			socket: state.socket,
		})),
	)

	// --- Worker Initialization ---
	useEffect(() => {
		initializeWorker()
		return () => {
			console.log('[Sync] Terminating worker via useSync cleanup.')
			terminateWorker()
		}
	}, [initializeWorker, terminateWorker])

	// Keep track of previously synced files to avoid resending unchanged files
	const prevSyncedFilesRef = useRef<Record<string, string>>({})

	// Reset prevSyncedFilesRef when fileId changes to prevent leakage across files
	useEffect(() => {
		prevSyncedFilesRef.current = {}
		console.debug('[Sync] Cleared prevSyncedFilesRef due to fileId change:', fileId)
	}, [fileId]) // Depends on fileId from the hook scope

	// --- Sync Logic ---

	// Saves current state to IndexedDB
	const doSyncToLocal = useCallback(async () => {
		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI || isReadOnly) {
			console.debug('[Sync] Not ready for local sync:', {
				isWorkerReady,
				hasWorker: !!worker,
				hasFileId: !!fileId,
				hasApi: !!excalidrawAPI,
				isReadOnly,
			})
			return
		}

		try {
			console.debug(`[Sync] Preparing local sync for file ${fileId}`)
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as any
			const appState = excalidrawAPI.getAppState() as any
			const files = excalidrawAPI.getFiles() as any
			const filteredAppState = { ...appState }
			delete filteredAppState?.collaborators
			delete filteredAppState?.selectedElementIds

			console.debug(`[Sync] Sending ${elements.length} elements to worker for local sync.`)
			worker.postMessage({ type: 'SYNC_TO_LOCAL', fileId, elements, files, appState: filteredAppState })
			logSyncResult('local', { status: 'syncing' })
		} catch (error) {
			console.error('[Sync] Local sync failed:', error)
			logSyncResult('local', { status: 'error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [isWorkerReady, worker, fileId, excalidrawAPI, isReadOnly])

	// Saves current state to the Nextcloud server API
	const doSyncToServerAPI = useCallback(async () => {
		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI || !isDedicatedSyncer || isReadOnly || collabStatus !== 'online') {
			console.debug('[Sync] Not ready for server sync:', {
				isWorkerReady,
				hasWorker: !!worker,
				hasFileId: !!fileId,
				hasApi: !!excalidrawAPI,
				isDedicatedSyncer,
				isReadOnly,
				collabStatus,
			})
			return
		}

		logSyncResult('server', { status: 'syncing API' })

		try {
			const jwt = await getJWT()
			if (!jwt) throw new Error('JWT token missing for server API sync.')
			if (useWhiteboardStore.getState().fileId !== fileId) {
				throw new Error('FileId changed during server sync preparation.')
			}

			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as any
			const files = excalidrawAPI.getFiles() as any

			worker.postMessage({
				type: 'SYNC_TO_SERVER', fileId, url: generateUrl(`apps/whiteboard/${fileId}`), jwt, elements, files,
			})
		} catch (error) {
			console.error('[Sync] Server API sync failed:', error)
			logSyncResult('server', { status: 'error API', error: error instanceof Error ? error.message : String(error) })
		}
	}, [isWorkerReady, worker, fileId, excalidrawAPI, isDedicatedSyncer, isReadOnly, collabStatus, getJWT])

	// Simple hash function for file content
	const hashFileContent = (content: string): string => {
		if (!content) return ''
		const len = content.length
		const start = content.substring(0, 20)
		const end = content.substring(Math.max(0, len - 20))
		return `${len}:${start}:${end}`
	}

	// Syncs scene and files via WebSocket
	const doSyncViaWebSocket = useCallback(async () => {
		if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online' || isReadOnly) {
			console.debug('[Sync] Not ready for websocket sync:', {
				hasFileId: !!fileId,
				hasApi: !!excalidrawAPI,
				hasSocket: !!socket,
				collabStatus,
				isReadOnly,
			})
			return
		}

		try {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
			const files = excalidrawAPI.getFiles()

			// 1. Send Scene
			const sceneData = { type: SyncMessageType.SceneInit, payload: { elements } }
			const sceneJson = JSON.stringify(sceneData)
			const sceneBuffer = new TextEncoder().encode(sceneJson)
			socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, sceneBuffer, [])

			// 2. Send only new or changed files
			if (files && Object.keys(files).length > 0) {
				const currentFileHashes: Record<string, string> = {}
				let changedFilesCount = 0
				for (const fileIdKey in files) {
					const file = files[fileIdKey]
					if (!file?.dataURL) continue
					const currentHash = hashFileContent(file.dataURL)
					currentFileHashes[fileIdKey] = currentHash
					if (prevSyncedFilesRef.current[fileIdKey] !== currentHash) {
						const fileData = { type: SyncMessageType.ImageAdd, payload: { file } }
						const fileJson = JSON.stringify(fileData)
						const fileBuffer = new TextEncoder().encode(fileJson)
						socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, fileBuffer, [])
						changedFilesCount++
					}
				}
				prevSyncedFilesRef.current = currentFileHashes
				logSyncResult('websocket', { status: 'sync success', elementsCount: elements.length })
				console.log(`[Sync] WebSocket sync: ${Object.keys(files).length} files, ${changedFilesCount} changed`)
			} else {
				logSyncResult('websocket', { status: 'sync success', elementsCount: elements.length })
				console.log('[Sync] WebSocket sync: 0 files')
				prevSyncedFilesRef.current = {}
			}
		} catch (error) {
			console.error('[Sync] WebSocket sync failed:', error)
			logSyncResult('websocket', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [fileId, excalidrawAPI, socket, collabStatus, isReadOnly])

	const throttledSyncToLocal = useMemo(() =>
		// Use both leading and trailing edge executions to ensure changes are saved immediately and after delay
		throttle(doSyncToLocal, LOCAL_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncToLocal])

	const throttledSyncToServerAPI = useMemo(() =>
		// Use both leading and trailing edge executions for server sync
		throttle(doSyncToServerAPI, SERVER_API_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncToServerAPI])

	const throttledSyncViaWebSocket = useMemo(() =>
		// Use both leading and trailing edge executions for WebSocket sync
		throttle(doSyncViaWebSocket, WEBSOCKET_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncViaWebSocket])

	// --- Event Handlers ---
	const onChange = useCallback(() => {
		throttledSyncToLocal()
		throttledSyncToServerAPI()
		throttledSyncViaWebSocket()

		console.debug('[Sync] Changes detected, triggered sync operations')
	}, [throttledSyncToLocal, throttledSyncToServerAPI, throttledSyncViaWebSocket])

	// --- Cursor Sync ---
	const doSyncCursors = useCallback(
		(payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
		}) => {
			if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online') {
				console.debug('[Sync] Not ready for cursor sync:', {
					hasFileId: !!fileId,
					hasApi: !!excalidrawAPI,
					hasSocket: !!socket,
					collabStatus,
				})
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
				const json = JSON.stringify(data)
				const encodedBuffer = new TextEncoder().encode(json)
				socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, encodedBuffer, [])
				logSyncResult('cursor', { status: 'sync success' })
			} catch (error) {
				console.error('[Sync] Error syncing cursor:', error)
				logSyncResult('cursor', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
			}
		},
		[fileId, excalidrawAPI, socket, collabStatus],
	)

	const throttledSyncCursors = useMemo(() =>
		throttle(doSyncCursors, CURSOR_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncCursors])

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
		const handleBeforeUnload = () => {
			if (excalidrawAPI && !isReadOnly) {
				console.log('[Sync] Saving state locally on page unload (beforeunload).')
				// Cancel any pending throttled trailing call FIRST
				throttledSyncToLocal.cancel()
				// Call the unthrottled version directly, ensures latest state is attempted
				doSyncToLocal()
			} else {
				console.log('[Sync] Skipping local save on page unload (no API or read-only).')
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		// Cleanup function for component unmount
		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			console.log('[Sync] Cleaning up sync hook on unmount.')

			// Cancel all throttled functions to prevent them from running after unmount
			throttledSyncToLocal.cancel()
			throttledSyncToServerAPI.cancel()
			throttledSyncViaWebSocket.cancel()
			throttledSyncCursors.cancel()
			console.log('[Sync] Cancelled throttled functions on unmount.')
		}
	}, [doSyncToLocal, throttledSyncToLocal, throttledSyncToServerAPI, throttledSyncViaWebSocket, throttledSyncCursors, excalidrawAPI, isReadOnly])

	return { onChange, onPointerUpdate }
}
