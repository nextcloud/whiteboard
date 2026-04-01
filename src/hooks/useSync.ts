/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { throttle } from 'lodash'
import { generateUrl } from '@nextcloud/router'
import { useShallow } from 'zustand/react/shallow'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'
import type { CollaborationSocket } from '../types/collaboration'
import type { WorkerInboundMessage } from '../types/protocol'
import logger from '../utils/logger'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'
import { yieldLocalSyncLeader } from './useLocalSyncLeader'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useLocalSyncLeaderStore } from '../stores/useLocalSyncLeaderStore'
import { useSyncStore, logSyncResult } from '../stores/useSyncStore'
import { selectEffectiveReadOnly, useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import {
	canRunAuthoritativeSync,
	canRunOnlineAuthoritativeSync,
	runServerApiSyncIfAllowed,
	runWebSocketSyncIfAllowed,
	type SyncAuthorityState,
	type SyncableExcalidrawAPI,
} from '../utils/syncExecution'

enum SyncMessageType {
	MouseLocation = 'MOUSE_LOCATION',
	ViewportUpdate = 'VIEWPORT_UPDATE',
	ServerVolatileBroadcast = 'server-volatile-broadcast',
}

const LOCAL_SYNC_DELAY = 1000
const SERVER_API_SYNC_DELAY = 10000
const WEBSOCKET_SYNC_DELAY = 500
const CURSOR_SYNC_DELAY = 50

export function useSync() {
	const { fileId, effectiveReadOnly } = useWhiteboardConfigStore(
		useShallow(state => ({
			fileId: state.fileId,
			effectiveReadOnly: selectEffectiveReadOnly(state),
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
			excalidrawAPI: state.excalidrawAPI as SyncableExcalidrawAPI | null,
		})),
	)

	const { isDedicatedSyncer, status: collabStatus, socket } = useCollaborationStore(
		useShallow(state => ({
			isDedicatedSyncer: state.isDedicatedSyncer,
			status: state.status,
			socket: state.socket as CollaborationSocket | null,
		})),
	)

	const { isLocalLeader } = useLocalSyncLeaderStore(
		useShallow(state => ({
			isLocalLeader: state.isLocalLeader,
		})),
	)

	const authority = useMemo<SyncAuthorityState>(() => ({
		isDedicatedSyncer,
		isLocalLeader,
		isReadOnly: effectiveReadOnly,
	}), [effectiveReadOnly, isDedicatedSyncer, isLocalLeader])

	const cachedStateRef = useRef<{ elements: readonly ExcalidrawElement[]; files: BinaryFiles }>({
		elements: [],
		files: {} as BinaryFiles,
	})
	const prevSyncedFilesRef = useRef<Record<string, string>>({})
	const lastBroadcastedViewportRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 })
	const canExecuteSyncRef = useRef(canRunAuthoritativeSync(authority))

	useEffect(() => {
		initializeWorker()
		return () => {
			terminateWorker()
		}
	}, [initializeWorker, terminateWorker])

	useEffect(() => {
		prevSyncedFilesRef.current = {}
		lastBroadcastedViewportRef.current = { scrollX: 0, scrollY: 0, zoom: 1 }
	}, [fileId])

	const doSyncToLocal = useCallback(async () => {
		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI || !canRunAuthoritativeSync(authority)) {
			return
		}

		try {
			const message: WorkerInboundMessage = {
				type: 'SYNC_TO_LOCAL',
				fileId,
				elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
				files: excalidrawAPI.getFiles(),
				appState: sanitizeAppStateForSync(excalidrawAPI.getAppState()),
			}
			worker.postMessage(message)
			logSyncResult('local', { status: 'syncing' })
		} catch (error) {
			logger.error('[Sync] Local sync failed:', error)
			logSyncResult('local', { status: 'error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [authority, excalidrawAPI, fileId, isWorkerReady, worker])

	const doSyncToServerAPI = useCallback(async (forceSync = false) => {
		logger.debug('[Sync] doSyncToServerAPI called', {
			forceSync,
			isDedicatedSyncer,
			isLocalLeader,
			collabStatus,
		})

		if (!isWorkerReady || !worker || !fileId || !excalidrawAPI) {
			return
		}

		const hasAuthority = canRunAuthoritativeSync(authority)
		if (!hasAuthority || (!forceSync && collabStatus !== 'online')) {
			logger.debug('[Sync] Skipping server sync - authority or connection missing', {
				forceSync,
				hasAuthority,
				collabStatus,
				fileId,
				isWorkerReady,
				hasWorker: Boolean(worker),
				hasExcalidrawAPI: Boolean(excalidrawAPI),
			})
			return
		}

		logSyncResult('server', { status: 'syncing API' })

		try {
			await runServerApiSyncIfAllowed({
				forceSync,
				authority,
				collabStatus,
				fileId,
				excalidrawAPI,
				getJWT,
				worker,
				isWorkerReady,
				currentFileId: useWhiteboardConfigStore.getState().fileId,
			})
			logger.debug('[Sync] SYNC_TO_SERVER message sent to worker')
		} catch (error) {
			logger.error('[Sync] Server API sync failed:', error)
			logSyncResult('server', { status: 'error API', error: error instanceof Error ? error.message : String(error) })
		}
	}, [
		authority,
		collabStatus,
		excalidrawAPI,
		fileId,
		getJWT,
		isDedicatedSyncer,
		isLocalLeader,
		isWorkerReady,
		worker,
	])

	const doSyncViaWebSocket = useCallback(async () => {
		try {
			const { sent, elementsCount, nextFileHashes } = runWebSocketSyncIfAllowed({
				authority,
				collabStatus,
				fileId,
				excalidrawAPI,
				socket,
				prevSyncedFiles: prevSyncedFilesRef.current,
			})

			if (!sent) {
				return
			}

			prevSyncedFilesRef.current = nextFileHashes
			logSyncResult('websocket', { status: 'sync success', elementsCount })
		} catch (error) {
			logger.error('[Sync] WebSocket sync failed:', error)
			logSyncResult('websocket', { status: 'sync error', error: error instanceof Error ? error.message : String(error) })
		}
	}, [authority, collabStatus, excalidrawAPI, fileId, socket])

	const throttledSyncToLocal = useMemo(() =>
		throttle(doSyncToLocal, LOCAL_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncToLocal])

	const throttledSyncToServerAPI = useMemo(() =>
		throttle(doSyncToServerAPI, SERVER_API_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncToServerAPI])

	const throttledSyncViaWebSocket = useMemo(() =>
		throttle(doSyncViaWebSocket, WEBSOCKET_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncViaWebSocket])

	const doSyncCursors = useCallback(
		(payload: {
			pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
			button: 'down' | 'up'
		}) => {
			if (!fileId || !excalidrawAPI || !socket || !canRunOnlineAuthoritativeSync(authority, collabStatus)) {
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
		[authority, collabStatus, excalidrawAPI, fileId, socket],
	)

	const doSyncViewport = useCallback(
		async (appState: { scrollX: number; scrollY: number; zoom: { value: number } }) => {
			if (!fileId || !excalidrawAPI || !socket || !canRunOnlineAuthoritativeSync(authority, collabStatus)) {
				return
			}

			const { scrollX, scrollY, zoom } = appState
			const lastViewport = lastBroadcastedViewportRef.current
			if (
				Math.abs(scrollX - lastViewport.scrollX) <= 5
				&& Math.abs(scrollY - lastViewport.scrollY) <= 5
				&& Math.abs(zoom.value - lastViewport.zoom) <= 0.01
			) {
				return
			}

			try {
				const { getJWT: resolveJWT, parseJwt } = useJWTStore.getState()
				const jwt = await resolveJWT()
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
				logger.error('[Sync] Error syncing viewport:', error)
			}
		},
		[authority, collabStatus, excalidrawAPI, fileId, socket],
	)

	const throttledSyncCursors = useMemo(() =>
		throttle(doSyncCursors, CURSOR_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncCursors])

	const throttledSyncViewport = useMemo(() =>
		throttle(doSyncViewport, CURSOR_SYNC_DELAY, { leading: true, trailing: true })
	, [doSyncViewport])

	const cancelThrottledSyncs = useCallback(() => {
		throttledSyncToLocal.cancel()
		throttledSyncToServerAPI.cancel()
		throttledSyncViaWebSocket.cancel()
		throttledSyncCursors.cancel()
		throttledSyncViewport.cancel()
	}, [
		throttledSyncCursors,
		throttledSyncToLocal,
		throttledSyncToServerAPI,
		throttledSyncViaWebSocket,
		throttledSyncViewport,
	])

	useEffect(() => {
		const nextCanExecute = canRunAuthoritativeSync(authority)
		if (nextCanExecute !== canExecuteSyncRef.current) {
			logger.debug('[Sync] Authoritative sync execution state changed', {
				isDedicatedSyncer,
				isLocalLeader,
				effectiveReadOnly,
				nextCanExecute,
			})
			if (!nextCanExecute) {
				cancelThrottledSyncs()
			}
			canExecuteSyncRef.current = nextCanExecute
		}
	}, [authority, cancelThrottledSyncs, effectiveReadOnly, isDedicatedSyncer, isLocalLeader])

	const onChange = useCallback(() => {
		if (excalidrawAPI) {
			cachedStateRef.current = {
				elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
				files: excalidrawAPI.getFiles(),
			}
		}

		throttledSyncToLocal()
		throttledSyncToServerAPI()
		throttledSyncViaWebSocket()

		if (excalidrawAPI) {
			throttledSyncViewport(excalidrawAPI.getAppState())
		}

		logger.debug('[Sync] Changes detected, triggered sync operations')
	}, [
		excalidrawAPI,
		throttledSyncToLocal,
		throttledSyncToServerAPI,
		throttledSyncViaWebSocket,
		throttledSyncViewport,
	])

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
		if (!fileId || !canExecuteSyncRef.current) {
			return
		}

		try {
			const jwtState = useJWTStore.getState()
			const jwt = jwtState.tokens[fileId]
			if (!jwt) {
				return
			}

			const { elements, files } = cachedStateRef.current
			const xhr = new XMLHttpRequest()
			xhr.open('PUT', generateUrl(`apps/whiteboard/${fileId}`), false)
			xhr.setRequestHeader('Content-Type', 'application/json')
			xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
			xhr.setRequestHeader('Authorization', `Bearer ${jwt}`)
			xhr.send(JSON.stringify({
				data: {
					elements,
					files: files || {},
				},
			}))

			logger.debug('[Sync] Final sync completed', { status: xhr.status, fileId })
		} catch (error) {
			logger.error('[Sync] Final sync failed:', error)
		}
	}, [fileId])

	const flushAndYieldLeadership = useCallback((reason: string) => {
		const shouldFlush = canExecuteSyncRef.current && excalidrawAPI && !effectiveReadOnly
		cancelThrottledSyncs()

		if (shouldFlush) {
			doSyncToLocal()
			doFinalServerSync()
		}

		if (canExecuteSyncRef.current) {
			yieldLocalSyncLeader(reason)
		}
	}, [cancelThrottledSyncs, doFinalServerSync, doSyncToLocal, effectiveReadOnly, excalidrawAPI])

	useEffect(() => {
		const handleBeforeUnload = () => {
			flushAndYieldLeadership('beforeunload')
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			flushAndYieldLeadership('unmount')
			cancelThrottledSyncs()
		}
	}, [cancelThrottledSyncs, flushAndYieldLeadership])

	return { onChange, onPointerUpdate }
}
