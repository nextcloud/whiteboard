/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { throttle } from 'lodash'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useSyncStore, logSyncResult } from '../stores/useSyncStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import logger from '../utils/logger'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types'
import type { CollaborationSocket } from '../types/collaboration'
import type { WorkerInboundMessage } from '../types/protocol'

enum SyncMessageType {
	SceneInit = 'SCENE_INIT',
	ImageAdd = 'IMAGE_ADD',
	MouseLocation = 'MOUSE_LOCATION',
	ViewportUpdate = 'VIEWPORT_UPDATE',
	ServerBroadcast = 'server-broadcast',
	ServerVolatileBroadcast = 'server-volatile-broadcast',
}

const LOCAL_SYNC_DELAY = 1000
const SERVER_API_SYNC_DELAY = 10000
const WEBSOCKET_SYNC_DELAY = 500
const CURSOR_SYNC_DELAY = 50

export function useSync() {
	const { fileId, isReadOnly } = useWhiteboardConfigStore(
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
			socket: state.socket as CollaborationSocket | null,
		})),
	)

	// --- Worker Initialization ---
	useEffect(() => {
		initializeWorker()
		return () => {
			terminateWorker()
		}
	}, [initializeWorker, terminateWorker])

	// Keep track of previously synced files to avoid resending unchanged files
	const prevSyncedFilesRef = useRef<Record<string, string>>({})

	// Reset prevSyncedFilesRef when fileId changes to prevent leakage across files
	useEffect(() => {
		prevSyncedFilesRef.current = {}
	}, [fileId]) // Depends on fileId from the hook scope

	// --- Sync Logic ---

	// Saves current state to IndexedDB
	const doSyncToLocal = useCallback(async () => {
		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI || isReadOnly) {
			return
		}

		try {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[]
			const appState = excalidrawAPI.getAppState()
			const files = excalidrawAPI.getFiles() as BinaryFiles
			const filteredAppState: Partial<AppState> = { ...appState }
			delete filteredAppState?.collaborators
			delete filteredAppState?.selectedElementIds

			const message: WorkerInboundMessage = { type: 'SYNC_TO_LOCAL', fileId, elements, files, appState: filteredAppState }
			worker.postMessage(message)
			logSyncResult('local', { status: 'syncing' })
		} catch (error) {
			logger.error('[Sync] Local sync failed:', error)
			logSyncResult('local', { status: 'error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [isWorkerReady, worker, fileId, excalidrawAPI, isReadOnly])

	// Saves current state to the Nextcloud server API
	const doSyncToServerAPI = useCallback(async (forceSync = false) => {
		logger.debug('[Sync] doSyncToServerAPI called', { forceSync, isDedicatedSyncer, collabStatus })

		// Allow force sync for final save, otherwise check normal conditions
		if (!forceSync && (!isWorkerReady || !worker || !fileId || !excalidrawAPI || !isDedicatedSyncer || isReadOnly || collabStatus !== 'online')) {
			logger.debug('[Sync] Skipping server sync - normal conditions not met', {
				isWorkerReady, worker: !!worker, fileId, excalidrawAPI: !!excalidrawAPI, isDedicatedSyncer, isReadOnly, collabStatus,
			})
			return
		}

		// For force sync, only check minimum requirements
		if (forceSync && (!isWorkerReady || !worker || !fileId || !excalidrawAPI || isReadOnly)) {
			logger.debug('[Sync] Skipping forced server sync - minimum requirements not met', {
				isWorkerReady, worker: !!worker, fileId, excalidrawAPI: !!excalidrawAPI, isReadOnly,
			})
			return
		}

		logSyncResult('server', { status: 'syncing API' })
		logger.debug('[Sync] Sending SYNC_TO_SERVER message to worker')

		try {
			const jwt = await getJWT()
			if (!jwt) throw new Error('JWT token missing for server API sync.')
			if (useWhiteboardConfigStore.getState().fileId !== fileId) {
				throw new Error('FileId changed during server sync preparation.')
			}

			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[]
			const files = excalidrawAPI.getFiles() as BinaryFiles

			const message: WorkerInboundMessage = {
				type: 'SYNC_TO_SERVER',
				fileId,
				url: generateUrl(`apps/whiteboard/${fileId}`),
				jwt,
				elements,
				files,
			}

			worker.postMessage(message)
			logger.debug('[Sync] SYNC_TO_SERVER message sent to worker')
		} catch (error) {
			logger.error('[Sync] Server API sync failed:', error)
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
			return
		}

		try {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[]
			const files = excalidrawAPI.getFiles() as BinaryFiles

			// 1. Send Scene
			const sceneData = { type: SyncMessageType.SceneInit, payload: { elements } }
			const sceneJson = JSON.stringify(sceneData)
			const sceneBuffer = new TextEncoder().encode(sceneJson)
			socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, sceneBuffer, [])

			// 2. Send only new or changed files
			if (files && Object.keys(files).length > 0) {
				const currentFileHashes: Record<string, string> = {}
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
					}
				}
				prevSyncedFilesRef.current = currentFileHashes
				logSyncResult('websocket', { status: 'sync success', elementsCount: elements.length })
			} else {
				logSyncResult('websocket', { status: 'sync success', elementsCount: elements.length })
				prevSyncedFilesRef.current = {}
			}
		} catch (error) {
			logger.error('[Sync] WebSocket sync failed:', error)
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
				const json = JSON.stringify(data)
				const encodedBuffer = new TextEncoder().encode(json)
				socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, encodedBuffer)
				logSyncResult('cursor', { status: 'sync success' })
			} catch (error) {
				logger.error('[Sync] Error syncing cursor:', error)
				logSyncResult('cursor', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
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
					// Get current user ID for viewport tracking
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
					const json = JSON.stringify(data)
					const encodedBuffer = new TextEncoder().encode(json)
					socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, encodedBuffer)

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
		// Update cached state immediately on every change
		if (excalidrawAPI) {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
			const files = excalidrawAPI.getFiles()
			cachedStateRef.current = { elements, files }
		}

		throttledSyncToLocal()
		throttledSyncToServerAPI()
		throttledSyncViaWebSocket()

		// Sync viewport changes
		if (excalidrawAPI) {
			const appState = excalidrawAPI.getAppState()
			throttledSyncViewport(appState)
		}

		logger.debug('[Sync] Changes detected, triggered sync operations')
	}, [throttledSyncToLocal, throttledSyncToServerAPI, throttledSyncViaWebSocket, throttledSyncViewport, excalidrawAPI])

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

	// Capture syncer state immediately to avoid closure issues
	const isSyncerRef = useRef(isDedicatedSyncer)
	useEffect(() => {
		if (isDedicatedSyncer !== isSyncerRef.current) {
			// eslint-disable-next-line no-console
			console.log('[Sync] SYNCER STATUS:', isDedicatedSyncer ? 'DESIGNATED AS SYNCER' : 'NOT SYNCER')
			isSyncerRef.current = isDedicatedSyncer
		}
	}, [isDedicatedSyncer])

	// Cache the latest state for final sync - update on EVERY change
	const cachedStateRef = useRef<{ elements: readonly ExcalidrawElement[]; files: BinaryFiles }>({ elements: [], files: {} as BinaryFiles })

	// Direct sync when leaving - synchronous to ensure it completes
	const doFinalServerSync = useCallback(() => {
		if (!fileId || !isSyncerRef.current) {
			return
		}

		// eslint-disable-next-line no-console
		console.log('[Sync] Executing final sync on page leave')

		try {
			// Get JWT from store - it's stored in tokens[fileId]
			const jwtState = useJWTStore.getState()
			const jwt = jwtState.tokens[fileId]

			if (!jwt) {
				return
			}

			// Use CACHED state instead of trying to get it now (might be cleared already)
			const { elements, files } = cachedStateRef.current
			// eslint-disable-next-line no-console
			console.log('[Sync] Using cached state with', elements.length, 'elements')

			const url = generateUrl(`apps/whiteboard/${fileId}`)

			const data = JSON.stringify({
				data: { elements, files: files || {} },
			})

			// Use synchronous XMLHttpRequest (works in beforeunload)
			const xhr = new XMLHttpRequest()
			xhr.open('PUT', url, false) // false = synchronous
			xhr.setRequestHeader('Content-Type', 'application/json')
			xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
			xhr.setRequestHeader('Authorization', `Bearer ${jwt}`)

			xhr.send(data)
			// eslint-disable-next-line no-console
			console.log('[Sync] Final sync done, status:', xhr.status)
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[Sync] Final sync failed:', error)
		}
	}, [fileId])

	useEffect(() => {
		const handleBeforeUnload = () => {
			if (excalidrawAPI && !isReadOnly && isSyncerRef.current) {
				// eslint-disable-next-line no-console
				console.log('[Sync] Page unloading - syncing as dedicated syncer')
				// Cancel any pending throttled trailing call FIRST
				throttledSyncToLocal.cancel()
				throttledSyncToServerAPI.cancel()
				// Call the unthrottled versions directly
				doSyncToLocal()
				doFinalServerSync()
			}
		}

		// Also handle visibility change as backup for mobile/tabs
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden' && isSyncerRef.current && excalidrawAPI && !isReadOnly) {
				throttledSyncToLocal.cancel()
				throttledSyncToServerAPI.cancel()
				doSyncToLocal()
				doFinalServerSync()
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)
		document.addEventListener('visibilitychange', handleVisibilityChange)

		// Cleanup function for component unmount
		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			document.removeEventListener('visibilitychange', handleVisibilityChange)

			// If we're the dedicated syncer and unmounting, do a final sync
			if (isSyncerRef.current && excalidrawAPI && !isReadOnly) {
				// Cancel pending throttled calls
				throttledSyncToLocal.cancel()
				throttledSyncToServerAPI.cancel()
				// Do final syncs
				doSyncToLocal()
				doFinalServerSync()
			}

			// Cancel all throttled functions to prevent them from running after unmount
			throttledSyncToLocal.cancel()
			throttledSyncToServerAPI.cancel()
			throttledSyncViaWebSocket.cancel()
			throttledSyncCursors.cancel()
		}
	}, [doSyncToLocal, doSyncToServerAPI, doFinalServerSync, throttledSyncToLocal, throttledSyncToServerAPI, throttledSyncViaWebSocket, throttledSyncCursors, excalidrawAPI, isReadOnly])

	return { onChange, onPointerUpdate }
}
