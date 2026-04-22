/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { throttle } from 'lodash'
import { hashString } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useSyncStore, logSyncResult } from '../stores/useSyncStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import logger from '../utils/logger'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'
import type { CollaborationSocket } from '../types/collaboration'
import type { WorkerInboundMessage } from '../types/protocol'
import {
	buildBroadcastedElementVersions,
	planIncrementalSceneSync,
} from '../utils/syncSceneData'

enum SyncMessageType {
	SceneUpdate = 'SCENE_UPDATE',
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

type SceneSnapshot = {
	elements: readonly ExcalidrawElement[]
	files: BinaryFiles
	appState: Partial<AppState>
}

declare global {
	interface Window {
		__whiteboardTest?: boolean
		__whiteboardTestHooks?: Record<string, unknown> & {
			syncDebugState?: Record<string, unknown>
		}
	}
}

const publishSyncDebugState = (partialState: Record<string, unknown>) => {
	if (typeof window === 'undefined' || !window.__whiteboardTest) {
		return
	}

	window.__whiteboardTestHooks = window.__whiteboardTestHooks || {}
	const currentState = (window.__whiteboardTestHooks.syncDebugState as Record<string, unknown> | undefined) || {}
	window.__whiteboardTestHooks.syncDebugState = {
		...currentState,
		...partialState,
	}
}

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

	const latestSnapshotRef = useRef<SceneSnapshot>({
		elements: [],
		files: {} as BinaryFiles,
		appState: {},
	})
	const prevSyncedFilesRef = useRef<Record<string, number>>({})
	const isSyncerRef = useRef(isDedicatedSyncer)
	const pendingLocalSyncRef = useRef(false)
	const pendingServerSyncRef = useRef(false)
	const pendingWebSocketSyncRef = useRef(false)

	const captureSnapshot = useCallback((
		elements?: readonly ExcalidrawElement[],
		appState?: AppState,
		files?: BinaryFiles,
	): SceneSnapshot | null => {
		if (!excalidrawAPI) {
			return null
		}

		const snapshotElements = elements ?? excalidrawAPI.getSceneElementsIncludingDeleted()
		const snapshotAppState = sanitizeAppStateForSync(appState ?? excalidrawAPI.getAppState())
		const snapshotFiles = (files ?? excalidrawAPI.getFiles()) as BinaryFiles

		latestSnapshotRef.current = {
			elements: snapshotElements,
			files: snapshotFiles,
			appState: snapshotAppState,
		}

		publishSyncDebugState({
			latestElementsCount: snapshotElements.length,
			latestFileCount: Object.keys(snapshotFiles || {}).length,
		})

		return latestSnapshotRef.current
	}, [excalidrawAPI])

	const getLatestSnapshot = useCallback(() => {
		return captureSnapshot() ?? latestSnapshotRef.current
	}, [captureSnapshot])

	useEffect(() => {
		initializeWorker()
		return () => {
			terminateWorker()
		}
	}, [initializeWorker, terminateWorker])

	useEffect(() => {
		prevSyncedFilesRef.current = {}
		pendingLocalSyncRef.current = false
		pendingServerSyncRef.current = false
		pendingWebSocketSyncRef.current = false
		publishSyncDebugState({
			pendingLocalSync: false,
			pendingServerSync: false,
			pendingWebSocketSync: false,
		})
		useCollaborationStore.getState().resetSceneSyncState()
	}, [fileId])

	useEffect(() => {
		if (isDedicatedSyncer !== isSyncerRef.current) {
			logger.debug('[Sync] SYNCER STATUS:', isDedicatedSyncer ? 'DESIGNATED AS SYNCER' : 'NOT SYNCER')
			isSyncerRef.current = isDedicatedSyncer
		}
	}, [isDedicatedSyncer])

	const doSyncToLocal = useCallback(async () => {
		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI || isReadOnly) {
			publishSyncDebugState({
				lastLocalSyncSkip: {
					isWorkerReady,
					hasWorker: Boolean(worker),
					fileId,
					hasExcalidrawAPI: Boolean(excalidrawAPI),
					isReadOnly,
				},
			})
			return
		}

		try {
			const snapshot = getLatestSnapshot()
			if (!snapshot) {
				return
			}

			const message: WorkerInboundMessage = {
				type: 'SYNC_TO_LOCAL',
				fileId,
				elements: snapshot.elements,
				files: snapshot.files,
				appState: snapshot.appState,
			}
			worker.postMessage(message)
			pendingLocalSyncRef.current = false
			publishSyncDebugState({
				lastLocalSyncPostedAt: Date.now(),
				pendingLocalSync: false,
			})
			logSyncResult('local', { status: 'syncing' })
		} catch (error) {
			logger.error('[Sync] Local sync failed:', error)
			logSyncResult('local', { status: 'error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [isWorkerReady, worker, fileId, excalidrawAPI, isReadOnly, getLatestSnapshot])

	const doSyncToServerAPI = useCallback(async (forceSync = false) => {
		logger.debug('[Sync] doSyncToServerAPI called', { forceSync, isDedicatedSyncer, collabStatus })
		publishSyncDebugState({
			lastServerSyncAttemptAt: Date.now(),
			lastServerSyncForce: forceSync,
			lastServerSyncGate: {
				isWorkerReady,
				hasWorker: Boolean(worker),
				fileId,
				hasExcalidrawAPI: Boolean(excalidrawAPI),
				isDedicatedSyncer,
				isReadOnly,
				collabStatus,
			},
		})

		if (!forceSync && (!isWorkerReady || !worker || !fileId || !excalidrawAPI || !isDedicatedSyncer || isReadOnly || collabStatus !== 'online')) {
			logger.debug('[Sync] Skipping server sync - normal conditions not met', {
				isWorkerReady, worker: !!worker, fileId, excalidrawAPI: !!excalidrawAPI, isDedicatedSyncer, isReadOnly, collabStatus,
			})
			publishSyncDebugState({
				lastServerSyncSkippedAt: Date.now(),
				lastServerSyncSkipReason: 'normal-conditions-not-met',
			})
			return
		}

		if (forceSync && (!isWorkerReady || !worker || !fileId || !excalidrawAPI || isReadOnly)) {
			logger.debug('[Sync] Skipping forced server sync - minimum requirements not met', {
				isWorkerReady, worker: !!worker, fileId, excalidrawAPI: !!excalidrawAPI, isReadOnly,
			})
			publishSyncDebugState({
				lastServerSyncSkippedAt: Date.now(),
				lastServerSyncSkipReason: 'forced-minimum-requirements-not-met',
			})
			return
		}

		logSyncResult('server', { status: 'syncing API' })

		try {
			const jwt = await getJWT()
			if (!jwt) throw new Error('JWT token missing for server API sync.')
			if (useWhiteboardConfigStore.getState().fileId !== fileId) {
				throw new Error('FileId changed during server sync preparation.')
			}

			const snapshot = getLatestSnapshot()
			if (!snapshot) {
				return
			}

			const message: WorkerInboundMessage = {
				type: 'SYNC_TO_SERVER',
				fileId,
				url: generateUrl(`apps/whiteboard/${fileId}`),
				jwt,
				elements: snapshot.elements,
				files: snapshot.files,
			}

			worker.postMessage(message)
			logger.debug('[Sync] SYNC_TO_SERVER message sent to worker')
			pendingServerSyncRef.current = false
			publishSyncDebugState({
				lastServerSyncPostedAt: Date.now(),
				pendingServerSync: false,
			})
		} catch (error) {
			logger.error('[Sync] Server API sync failed:', error)
			publishSyncDebugState({
				lastServerSyncErrorAt: Date.now(),
				lastServerSyncError: error instanceof Error ? error.message : String(error),
			})
			logSyncResult('server', { status: 'error API', error: error instanceof Error ? error.message : String(error) })
		}
	}, [isWorkerReady, worker, fileId, excalidrawAPI, isDedicatedSyncer, isReadOnly, collabStatus, getJWT, getLatestSnapshot])

	const doSyncViaWebSocket = useCallback(async () => {
		if (!fileId || !socket || collabStatus !== 'online' || isReadOnly) {
			publishSyncDebugState({
				lastWebSocketSyncSkip: {
					fileId,
					hasSocket: Boolean(socket),
					collabStatus,
					isReadOnly,
				},
			})
			return
		}

		try {
			const snapshot = getLatestSnapshot()
			if (!snapshot) {
				return
			}

			const { elements, files } = snapshot
			const sceneSyncPlan = planIncrementalSceneSync({
				elements,
				broadcastedElementVersions: useCollaborationStore.getState().broadcastedElementVersions,
				lastSceneHash: useCollaborationStore.getState().lastSceneHash,
			})
			let syncedElementsCount = 0

			if (sceneSyncPlan.type === 'broadcast') {
				const sceneData = {
					type: SyncMessageType.SceneUpdate,
					payload: {
						elements: sceneSyncPlan.sceneElements,
					},
				}
				const sceneBuffer = new TextEncoder().encode(JSON.stringify(sceneData))
				socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, sceneBuffer, [])

				useCollaborationStore.getState().replaceBroadcastedElementVersions(
					buildBroadcastedElementVersions(elements),
				)
				useCollaborationStore.getState().setLastSceneHash(sceneSyncPlan.sceneHash)
				syncedElementsCount = sceneSyncPlan.sceneElements.length
			} else if (sceneSyncPlan.type === 'advance') {
				useCollaborationStore.getState().replaceBroadcastedElementVersions(
					sceneSyncPlan.broadcastedElementVersions,
				)
				useCollaborationStore.getState().setLastSceneHash(sceneSyncPlan.sceneHash)
			}

			if (files && Object.keys(files).length > 0) {
				const currentFileHashes: Record<string, number> = {}
				for (const fileIdKey in files) {
					const file = files[fileIdKey]
					if (!file?.dataURL) continue
					const currentHash = hashString(file.dataURL)
					currentFileHashes[fileIdKey] = currentHash
					if (prevSyncedFilesRef.current[fileIdKey] !== currentHash) {
						const fileData = { type: SyncMessageType.ImageAdd, payload: { file } }
						const fileBuffer = new TextEncoder().encode(JSON.stringify(fileData))
						socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, fileBuffer, [])
					}
				}
				prevSyncedFilesRef.current = currentFileHashes
			} else {
				prevSyncedFilesRef.current = {}
			}

			pendingWebSocketSyncRef.current = false
			publishSyncDebugState({
				lastWebSocketSyncPostedAt: Date.now(),
				pendingWebSocketSync: false,
			})
			logSyncResult('websocket', { status: 'sync success', elementsCount: syncedElementsCount })
		} catch (error) {
			logger.error('[Sync] WebSocket sync failed:', error)
			logSyncResult('websocket', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [fileId, socket, collabStatus, isReadOnly, getLatestSnapshot])

	const throttledSyncToLocal = useMemo(() =>
		throttle(doSyncToLocal, LOCAL_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncToLocal])

	const throttledSyncToServerAPI = useMemo(() =>
		throttle(doSyncToServerAPI, SERVER_API_SYNC_DELAY, { leading: false, trailing: true })
	, [doSyncToServerAPI])

	const throttledSyncViaWebSocket = useMemo(() =>
		throttle(() => {
			doSyncViaWebSocket().catch((error) => {
				logger.error('[Sync] Throttled WebSocket sync failed:', error)
			})
		}, WEBSOCKET_SYNC_DELAY, { leading: false, trailing: true })
	, [doSyncViaWebSocket])

	useEffect(() => {
		if (pendingLocalSyncRef.current && isWorkerReady && worker && fileId && excalidrawAPI && !isReadOnly) {
			publishSyncDebugState({ lastLocalSyncRescheduledAt: Date.now() })
			throttledSyncToLocal()
		}

		if (pendingWebSocketSyncRef.current && fileId && socket && collabStatus === 'online' && !isReadOnly) {
			publishSyncDebugState({ lastWebSocketSyncRescheduledAt: Date.now() })
			throttledSyncViaWebSocket()
		}

		if (
			pendingServerSyncRef.current
			&& isWorkerReady
			&& worker
			&& fileId
			&& excalidrawAPI
			&& isDedicatedSyncer
			&& !isReadOnly
			&& collabStatus === 'online'
		) {
			publishSyncDebugState({ lastServerSyncRescheduledAt: Date.now() })
			throttledSyncToServerAPI()
		}
	}, [
		collabStatus,
		excalidrawAPI,
		fileId,
		isDedicatedSyncer,
		isReadOnly,
		isWorkerReady,
		socket,
		throttledSyncToLocal,
		throttledSyncToServerAPI,
		throttledSyncViaWebSocket,
		worker,
	])

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
				const encodedBuffer = new TextEncoder().encode(JSON.stringify(data))
				socket.emit(SyncMessageType.ServerVolatileBroadcast, `${fileId}`, encodedBuffer)
				logSyncResult('cursor', { status: 'sync success' })
			} catch (error) {
				logger.error('[Sync] Error syncing cursor:', error)
				logSyncResult('cursor', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
			}
		},
		[fileId, excalidrawAPI, socket, collabStatus],
	)

	const lastBroadcastedViewportRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 })

	const doSyncViewport = useCallback(
		async (appState: { scrollX: number; scrollY: number; zoom: { value: number } }) => {
			if (!fileId || !excalidrawAPI || !socket || collabStatus !== 'online') {
				return
			}

			const { scrollX, scrollY, zoom } = appState
			const lastViewport = lastBroadcastedViewportRef.current

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
					const encodedBuffer = new TextEncoder().encode(JSON.stringify(data))
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

	const onChange = useCallback((
		elements?: readonly ExcalidrawElement[],
		appState?: AppState,
		files?: BinaryFiles,
	) => {
		pendingLocalSyncRef.current = true
		pendingServerSyncRef.current = true
		pendingWebSocketSyncRef.current = true
		publishSyncDebugState({
			lastOnChangeAt: Date.now(),
			pendingLocalSync: true,
			pendingServerSync: true,
			pendingWebSocketSync: true,
		})

		const snapshot = captureSnapshot(elements, appState, files)
		if (snapshot) {
			latestSnapshotRef.current = snapshot
		}

		throttledSyncToLocal()
		throttledSyncToServerAPI()
		throttledSyncViaWebSocket()

		if (appState) {
			throttledSyncViewport(appState)
		} else if (excalidrawAPI) {
			throttledSyncViewport(excalidrawAPI.getAppState())
		}

		logger.debug('[Sync] Changes detected, triggered sync operations')
	}, [captureSnapshot, throttledSyncToLocal, throttledSyncToServerAPI, throttledSyncViaWebSocket, throttledSyncViewport, excalidrawAPI])

	const onPointerUpdate = useCallback(
		(payload: {
			pointersMap: Map<string, { x: number; y: number }>
			pointer: { x: number; y: number; tool: 'laser' | 'pointer' }
			button: 'down' | 'up'
		}) => {
			if (payload.pointersMap.size < 2) {
				throttledSyncCursors({ pointer: payload.pointer, button: payload.button })
			}
		},
		[throttledSyncCursors],
	)

	const doFinalServerSync = useCallback(() => {
		if (!fileId || !isSyncerRef.current) {
			return
		}

		try {
			const jwtState = useJWTStore.getState()
			const jwt = jwtState.tokens[fileId]

			if (!jwt) {
				return
			}

			const snapshot = getLatestSnapshot()
			const url = generateUrl(`apps/whiteboard/${fileId}`)

			const data = JSON.stringify({
				data: { elements: snapshot.elements, files: snapshot.files || {} },
			})

			const xhr = new XMLHttpRequest()
			xhr.open('PUT', url, false)
			xhr.setRequestHeader('Content-Type', 'application/json')
			xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
			xhr.setRequestHeader('Authorization', `Bearer ${jwt}`)
			xhr.send(data)
		} catch (error) {
			console.error('[Sync] Final sync failed:', error)
		}
	}, [fileId, getLatestSnapshot])

	const excalidrawAPIRef = useRef(excalidrawAPI)
	const isReadOnlyRef = useRef(isReadOnly)
	const doSyncToLocalRef = useRef(doSyncToLocal)
	const doFinalServerSyncRef = useRef(doFinalServerSync)
	const throttledSyncToLocalRef = useRef(throttledSyncToLocal)
	const throttledSyncToServerAPIRef = useRef(throttledSyncToServerAPI)
	const throttledSyncViaWebSocketRef = useRef(throttledSyncViaWebSocket)
	const throttledSyncCursorsRef = useRef(throttledSyncCursors)

	useEffect(() => {
		excalidrawAPIRef.current = excalidrawAPI
	}, [excalidrawAPI])

	useEffect(() => {
		isReadOnlyRef.current = isReadOnly
	}, [isReadOnly])

	useEffect(() => {
		doSyncToLocalRef.current = doSyncToLocal
	}, [doSyncToLocal])

	useEffect(() => {
		doFinalServerSyncRef.current = doFinalServerSync
	}, [doFinalServerSync])

	useEffect(() => {
		throttledSyncToLocalRef.current = throttledSyncToLocal
	}, [throttledSyncToLocal])

	useEffect(() => {
		throttledSyncToServerAPIRef.current = throttledSyncToServerAPI
	}, [throttledSyncToServerAPI])

	useEffect(() => {
		throttledSyncViaWebSocketRef.current = throttledSyncViaWebSocket
	}, [throttledSyncViaWebSocket])

	useEffect(() => {
		throttledSyncCursorsRef.current = throttledSyncCursors
	}, [throttledSyncCursors])

	useEffect(() => {
		const flushFinalSync = (reason: 'unload' | 'visibility change') => {
			if (!excalidrawAPIRef.current || isReadOnlyRef.current || !isSyncerRef.current) {
				return
			}

			throttledSyncToLocalRef.current.cancel()
			throttledSyncToServerAPIRef.current.cancel()
			doSyncToLocalRef.current().catch((error) => {
				logger.error(`[Sync] Final local sync on ${reason} failed:`, error)
			})
			doFinalServerSyncRef.current()
		}

		const handleBeforeUnload = () => {
			flushFinalSync('unload')
		}

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				flushFinalSync('visibility change')
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)
		document.addEventListener('visibilitychange', handleVisibilityChange)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			document.removeEventListener('visibilitychange', handleVisibilityChange)
		}
	}, [])

	useEffect(() => {
		return () => {
			if (isSyncerRef.current && excalidrawAPIRef.current && !isReadOnlyRef.current) {
				throttledSyncToLocalRef.current.cancel()
				throttledSyncToServerAPIRef.current.cancel()
				doSyncToLocalRef.current().catch((error) => {
					logger.error('[Sync] Final local sync on cleanup failed:', error)
				})
				doFinalServerSyncRef.current()
			}

			throttledSyncToLocalRef.current.cancel()
			throttledSyncToServerAPIRef.current.cancel()
			throttledSyncViaWebSocketRef.current.cancel()
			throttledSyncCursorsRef.current.cancel()
		}
	}, [])

	return { onChange, onPointerUpdate }
}
