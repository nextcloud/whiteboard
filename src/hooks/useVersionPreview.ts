/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@nextcloud/l10n'
import { getRequestToken } from '@nextcloud/auth'
import { restoreElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useSyncStore } from '../stores/useSyncStore'
import { db } from '../database/db'
import { computeElementVersionHash } from '../utils/syncSceneData'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import logger from '../utils/logger'
import {
	areSnapshotsEquivalent,
	normalizePersistedBoardDocument,
	type PersistedBoardMeta,
} from '../utils/persistedBoardData'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

import { generateUrl } from '@nextcloud/router'

type RestoredSnapshot = {
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState: Partial<AppState>
	scrollToContent: boolean
	meta?: PersistedBoardMeta
}

interface UseVersionPreviewOptions {
	fileId: number
	versionSource: string | null
	fileVersion: string | null
	excalidrawAPI: ExcalidrawImperativeAPI | null
	refreshReadOnlyState: () => Promise<boolean>
	isReadOnly: boolean
}

export function useVersionPreview({
	fileId,
	versionSource,
	fileVersion,
	excalidrawAPI,
	refreshReadOnlyState,
	isReadOnly,
}: UseVersionPreviewOptions) {
	const { setConfig, setReadOnly } = useWhiteboardConfigStore(useShallow(state => ({
		setConfig: state.setConfig,
		setReadOnly: state.setReadOnly,
	})))
	const getJWT = useJWTStore(state => state.getJWT)

	const [currentVersionSource, setCurrentVersionSource] = useState(versionSource)
	const [currentFileVersion, setCurrentFileVersion] = useState(fileVersion)
	const [isRestoringVersion, setIsRestoringVersion] = useState(false)

	const isVersionPreview = Boolean(currentVersionSource && currentFileVersion)
	const previousReadOnlyRef = useRef<boolean | null>(null)
	const wasVersionPreviewRef = useRef(isVersionPreview)
	const pendingBroadcastRef = useRef<RestoredSnapshot | null>(null)

	useEffect(() => {
		setCurrentVersionSource(versionSource)
		setCurrentFileVersion(fileVersion)
	}, [versionSource, fileVersion])

	const resolveVersionEndpoints = useCallback((source: string | null) => {
		if (!source) {
			return null
		}

		try {
			const resolvedUrl = new URL(source, window.location.origin)
			const parts = resolvedUrl.pathname.split('/').filter(Boolean)
			const davIndex = parts.indexOf('dav')
			const firstVersionsIndex = parts.indexOf('versions', davIndex + 1)
			const secondVersionsIndex = parts.indexOf('versions', firstVersionsIndex + 1)
			if (davIndex === -1 || firstVersionsIndex === -1 || secondVersionsIndex === -1) {
				return null
			}
			const user = parts[firstVersionsIndex + 1]
			const fileIdFromPath = parts[secondVersionsIndex + 1]
			const versionId = parts[secondVersionsIndex + 2]

			if (!user || !fileIdFromPath || !versionId) {
				return null
			}

			const base = `${resolvedUrl.origin}/remote.php/dav/versions/${user}`

			return {
				restoreUrl: `${base}/versions/${fileIdFromPath}/${versionId}`,
				destinationUrl: `${base}/restore/target`,
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to resolve versionSource endpoint', { error, versionSource: source })
			return null
		}
	}, [])

	const versionLabel = useMemo(() => {
		if (!isVersionPreview || !currentFileVersion) {
			return null
		}
		return t('whiteboard', 'Version {version}', { version: currentFileVersion })
	}, [isVersionPreview, currentFileVersion])

	const versionSourceLabel = useMemo(() => {
		if (!isVersionPreview || !currentVersionSource) {
			return null
		}
		if (currentVersionSource.includes('/trashbin/')) {
			return t('whiteboard', 'Stored in trash history')
		}
		if (currentVersionSource.includes('/versions/')) {
			return t('whiteboard', 'Stored in file history')
		}
		return null
	}, [isVersionPreview, currentVersionSource])

	const versionDavEndpoints = useMemo(() => {
		if (!isVersionPreview || !currentVersionSource) {
			return null
		}
		return resolveVersionEndpoints(currentVersionSource)
	}, [isVersionPreview, currentVersionSource, resolveVersionEndpoints])

	const exitVersionPreview = useCallback(() => {
		try {
			const updatedUrl = new URL(window.location.href)
			updatedUrl.searchParams.delete('source')
			updatedUrl.searchParams.delete('fileVersion')
			window.history.replaceState(window.history.state, '', updatedUrl.toString())
		} catch (error) {
			logger.error('[useVersionPreview] Failed to update history when exiting version preview', error)
		}

		setCurrentVersionSource(null)
		setCurrentFileVersion(null)
		setConfig({
			isVersionPreview: false,
			versionSource: null,
			fileVersion: null,
		})
	}, [setConfig])

	const captureRestoredSnapshot = useCallback(async (sourceOverride?: string | null): Promise<RestoredSnapshot | null> => {
		try {
			const effectiveSource = sourceOverride ?? currentVersionSource
			if (effectiveSource) {
				const response = await fetch(effectiveSource, {
					method: 'GET',
					credentials: 'include',
					headers: {
						Accept: 'application/json',
					},
				})

				if (!response.ok) {
					throw new Error(`Failed to fetch version content: ${response.status}`)
				}

				const rawContent = await response.text()
				if (rawContent.trim() === '') {
					return {
						elements: [],
						files: {},
						appState: {},
						scrollToContent: true,
						meta: undefined,
					}
				}

				let parsedContent: unknown = null
				try {
					parsedContent = JSON.parse(rawContent)
				} catch {
					throw new Error('Failed to parse version content JSON')
				}

				if (!parsedContent) {
					throw new Error('Version content is missing elements array')
				}

				const persistedDocument = normalizePersistedBoardDocument(parsedContent)
				const sanitizedElements = restoreElements(persistedDocument.elements, null) as ExcalidrawElement[]
				const parsedAppState = sanitizeAppStateForSync(persistedDocument.appState)
				const appStateCopy: Partial<AppState> = { ...parsedAppState }
				appStateCopy.viewModeEnabled = false

				return {
					elements: sanitizedElements,
					files: persistedDocument.files,
					appState: appStateCopy,
					scrollToContent: persistedDocument.scrollToContent,
					meta: persistedDocument.meta,
				}
			}

			if (excalidrawAPI) {
				const rawElements = excalidrawAPI.getSceneElementsIncludingDeleted?.() || []
				const sanitizedElements = restoreElements(rawElements, null) as ExcalidrawElement[]
				const rawFiles = excalidrawAPI.getFiles?.() || {}
				const filesCopy: BinaryFiles = { ...rawFiles }
				const rawAppState = excalidrawAPI.getAppState?.() || {}
				const appStateCopy = sanitizeAppStateForSync(rawAppState)
				appStateCopy.viewModeEnabled = false
				const scrollToContent = typeof rawAppState.scrollToContent === 'boolean'
					? rawAppState.scrollToContent
					: true
				const runtimeSyncState = useSyncStore.getState()

				return {
					elements: sanitizedElements,
					files: filesCopy,
					appState: appStateCopy,
					scrollToContent,
					meta: {
						persistedRev: runtimeSyncState.persistedRev,
						updatedAt: runtimeSyncState.lastServerUpdatedAt,
						updatedBy: runtimeSyncState.lastServerUpdatedBy,
					},
				}
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to capture restored snapshot', error)
			return null
		}

		return null
	}, [excalidrawAPI, currentVersionSource])

	const applySnapshotToScene = useCallback((snapshot: RestoredSnapshot | null) => {
		if (!snapshot || !excalidrawAPI) {
			return
		}

		const { elements, files, appState, scrollToContent } = snapshot
		const sanitizedAppState: Partial<AppState> = {
			...sanitizeAppStateForSync(appState),
			viewModeEnabled: false,
		}

		excalidrawAPI.updateScene?.({
			elements,
			files,
			appState: {
				...sanitizedAppState,
				scrollToContent,
			},
		})
	}, [excalidrawAPI])

	const broadcastSnapshotToSocket = useCallback((snapshot: RestoredSnapshot): boolean => {
		const { socket: currentSocket, isInRoom } = useCollaborationStore.getState()
		if (!currentSocket?.connected || !fileId || !isInRoom) {
			return false
		}

		try {
			const encoder = new TextEncoder()
			const sanitizedAppState = {
				...sanitizeAppStateForSync(snapshot.appState),
				viewModeEnabled: false,
			}
			const scenePayload = {
				type: 'SCENE_RESTORE',
				payload: {
					elements: snapshot.elements,
					files: snapshot.files || {},
					appState: sanitizedAppState,
					scrollToContent: snapshot.scrollToContent,
				},
			}
			currentSocket.emit('server-broadcast', `${fileId}`, encoder.encode(JSON.stringify(scenePayload)), [])

			const fileValues = snapshot.files ? Object.values(snapshot.files) : []
			fileValues.forEach(file => {
				if (!file) {
					return
				}
				const filePayload = {
					type: 'IMAGE_ADD',
					payload: { file },
				}
				currentSocket.emit('server-broadcast', `${fileId}`, encoder.encode(JSON.stringify(filePayload)), [])
			})

			return true
		} catch (error) {
			logger.error('[useVersionPreview] Failed to broadcast restored version over socket', error)
			return false
		}
	}, [fileId])

	const persistRestoredSnapshot = useCallback(async (snapshot: RestoredSnapshot): Promise<boolean> => {
		if (!Number.isFinite(fileId) || fileId <= 0) {
			return false
		}

		const { elements, files, appState, scrollToContent } = snapshot
		const sanitizedAppState: Partial<AppState> = {
			...sanitizeAppStateForSync(appState),
			viewModeEnabled: false,
		}
		const filesToStore: BinaryFiles = files || {}
		const existing = await db.get(fileId)
		const localMeta = snapshot.meta ?? {
			persistedRev: existing?.persistedRev ?? 0,
			updatedAt: existing?.lastServerUpdatedAt ?? null,
			updatedBy: existing?.lastServerUpdatedBy ?? null,
		}

		await db.put(
			fileId,
			elements,
			filesToStore,
			sanitizedAppState,
			{
				scrollToContent,
				hasPendingLocalChanges: false,
				lastSyncedHash: computeElementVersionHash(elements),
				persistedRev: localMeta.persistedRev,
				lastServerUpdatedAt: localMeta.updatedAt,
				lastServerUpdatedBy: localMeta.updatedBy,
			},
		)
		useSyncStore.getState().setPersistedMetadata(localMeta)

		try {
			const jwt = await getJWT()
			if (jwt) {
				const response = await fetch(generateUrl(`apps/whiteboard/${fileId}`), {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						'X-Requested-With': 'XMLHttpRequest',
						Authorization: `Bearer ${jwt}`,
					},
					body: JSON.stringify({
						data: {
							baseRev: useSyncStore.getState().persistedRev,
							elements,
							files: filesToStore,
							appState: sanitizedAppState,
							scrollToContent,
						},
					}),
				})

				if (!response.ok && response.status !== 409) {
					throw new Error(`Unexpected status ${response.status}`)
				}

				if (response.status === 409) {
					const conflictResponse = await response.json()
					const conflictDocument = normalizePersistedBoardDocument(conflictResponse?.data)

					if (areSnapshotsEquivalent(snapshot, conflictDocument)) {
						await db.put(
							fileId,
							elements,
							filesToStore,
							sanitizedAppState,
							{
								scrollToContent,
								hasPendingLocalChanges: false,
								lastSyncedHash: computeElementVersionHash(conflictDocument.elements),
								persistedRev: conflictDocument.meta.persistedRev,
								lastServerUpdatedAt: conflictDocument.meta.updatedAt,
								lastServerUpdatedBy: conflictDocument.meta.updatedBy,
							},
						)
						useSyncStore.getState().setPersistedMetadata(conflictDocument.meta)
					} else {
						await db.put(
							fileId,
							conflictDocument.elements,
							conflictDocument.files,
							conflictDocument.appState,
							{
								scrollToContent: conflictDocument.scrollToContent,
								hasPendingLocalChanges: false,
								lastSyncedHash: computeElementVersionHash(conflictDocument.elements),
								persistedRev: conflictDocument.meta.persistedRev,
								lastServerUpdatedAt: conflictDocument.meta.updatedAt,
								lastServerUpdatedBy: conflictDocument.meta.updatedBy,
							},
						)
						useSyncStore.getState().setPersistedMetadata(conflictDocument.meta)
						logger.warn('[useVersionPreview] Restored snapshot diverged from durable server state, using server document')
					}
				} else {
					const responseData = await response.json()
					const responseMeta = normalizePersistedBoardDocument({
						meta: responseData?.meta,
					}).meta
					await db.put(
						fileId,
						elements,
						filesToStore,
						sanitizedAppState,
						{
							scrollToContent,
							hasPendingLocalChanges: false,
							lastSyncedHash: computeElementVersionHash(elements),
							persistedRev: responseMeta.persistedRev,
							lastServerUpdatedAt: responseMeta.updatedAt,
							lastServerUpdatedBy: responseMeta.updatedBy,
						},
					)
					useSyncStore.getState().setPersistedMetadata(responseMeta)
				}
			} else {
				logger.warn('[useVersionPreview] Skipping server sync for restored version due to missing JWT')
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to sync restored version to server', error)
		}

		const broadcasted = broadcastSnapshotToSocket({
			elements,
			files: filesToStore,
			appState: sanitizedAppState,
			scrollToContent,
		})

		return broadcasted
	}, [fileId, getJWT, broadcastSnapshotToSocket])

	const handleRestoreVersion = useCallback(async () => {
		if (!versionDavEndpoints) {
			showError(t('whiteboard', 'Could not restore this version'))
			return
		}

		setIsRestoringVersion(true)
		try {
			const snapshot = await captureRestoredSnapshot()

			const response = await fetch(versionDavEndpoints.restoreUrl, {
				method: 'MOVE',
				credentials: 'include',
				headers: {
					Destination: versionDavEndpoints.destinationUrl,
					'X-Requested-With': 'XMLHttpRequest',
					requesttoken: getRequestToken() || '',
					'OCS-APIREQUEST': 'true',
				},
			})

			if (!response.ok) {
				throw new Error(`Unexpected status ${response.status}`)
			}

			if (snapshot) {
				const broadcasted = await persistRestoredSnapshot(snapshot)
				if (!broadcasted) {
					pendingBroadcastRef.current = snapshot
				}
				applySnapshotToScene(snapshot)
			} else if (Number.isFinite(fileId) && fileId > 0) {
				await db.delete(fileId)
			}

			showSuccess(t('whiteboard', 'Version restored'))
			exitVersionPreview()
		} catch (error) {
			logger.error('[useVersionPreview] Failed to restore version', error)
			showError(t('whiteboard', 'Could not restore this version'))
		} finally {
			setIsRestoringVersion(false)
		}
	}, [versionDavEndpoints, captureRestoredSnapshot, persistRestoredSnapshot, fileId, exitVersionPreview])

	const handleExternalRestore = useCallback(async (source: string, fileVersionId: string | null) => {
		const endpoints = resolveVersionEndpoints(source)

		if (!endpoints) {
			showError(t('whiteboard', 'Could not restore this version'))
			logger.error('[useVersionPreview] Missing endpoints for external restore', { source, fileVersionId })
			return false
		}

		setIsRestoringVersion(true)
		try {
			const snapshot = await captureRestoredSnapshot(source)

			const response = await fetch(endpoints.restoreUrl, {
				method: 'MOVE',
				credentials: 'include',
				headers: {
					Destination: endpoints.destinationUrl,
					'X-Requested-With': 'XMLHttpRequest',
					requesttoken: getRequestToken() || '',
					'OCS-APIREQUEST': 'true',
				},
			})

			if (!response.ok) {
				logger.error('[useVersionPreview] Restore MOVE failed', { status: response.status, source })
				throw new Error(`Unexpected status ${response.status}`)
			}

			if (snapshot) {
				const broadcasted = await persistRestoredSnapshot(snapshot)
				if (!broadcasted) {
					pendingBroadcastRef.current = snapshot
				}
				applySnapshotToScene(snapshot)
			} else if (Number.isFinite(fileId) && fileId > 0) {
				await db.delete(fileId)
			}

			showSuccess(t('whiteboard', 'Version restored'))

			if (isVersionPreview && currentVersionSource === source) {
				exitVersionPreview()
			}

			setReadOnly(false)
			refreshReadOnlyState().catch(error => {
				logger.error('[useVersionPreview] Failed to refresh read-only state after external restore', error)
			})

			return true
		} catch (error) {
			logger.error('[useVersionPreview] Failed to restore version from sidebar', error)
			showError(t('whiteboard', 'Could not restore this version'))
			return false
		} finally {
			setIsRestoringVersion(false)
		}
	}, [captureRestoredSnapshot, currentVersionSource, exitVersionPreview, fileId, isVersionPreview, persistRestoredSnapshot, refreshReadOnlyState, resolveVersionEndpoints, setReadOnly])

	useEffect(() => {
		const unsubscribe = useCollaborationStore.subscribe(
			state => ({ socket: state.socket, status: state.status, isInRoom: state.isInRoom }),
			({ socket, status, isInRoom }) => {
				if (!pendingBroadcastRef.current) {
					return
				}
				if (status !== 'online' || !socket?.connected || !isInRoom) {
					return
				}

				const snapshot = pendingBroadcastRef.current
				const broadcasted = broadcastSnapshotToSocket(snapshot)
				if (broadcasted) {
					pendingBroadcastRef.current = null
					applySnapshotToScene(snapshot)
				}
			},
		)

		return () => {
			unsubscribe()
		}
	}, [broadcastSnapshotToSocket])

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null

		const tryBroadcast = () => {
			if (!pendingBroadcastRef.current) {
				return
			}
			const snapshot = pendingBroadcastRef.current
			const broadcasted = broadcastSnapshotToSocket(snapshot)
			if (broadcasted) {
				pendingBroadcastRef.current = null
				applySnapshotToScene(snapshot)
				return
			}
			timer = setTimeout(tryBroadcast, 1000)
		}

		if (pendingBroadcastRef.current) {
			timer = setTimeout(tryBroadcast, 500)
		}

		return () => {
			if (timer) {
				clearTimeout(timer)
			}
		}
	}, [broadcastSnapshotToSocket, applySnapshotToScene])

	useEffect(() => {
		pendingBroadcastRef.current = null
	}, [fileId])

	useLayoutEffect(() => {
		setConfig({
			isVersionPreview,
			versionSource: currentVersionSource,
			fileVersion: currentFileVersion,
		})
	}, [setConfig, isVersionPreview, currentVersionSource, currentFileVersion])

	useLayoutEffect(() => {
		const wasVersionPreview = wasVersionPreviewRef.current

		if (isVersionPreview) {
			if (!wasVersionPreview) {
				previousReadOnlyRef.current = isReadOnly
			}
			setReadOnly(true)
		} else if (wasVersionPreview) {
			if (previousReadOnlyRef.current !== null) {
				setReadOnly(previousReadOnlyRef.current)
			} else {
				refreshReadOnlyState().catch(error => {
					logger.error('[useVersionPreview] Failed to refresh read-only state after exiting version preview', error)
				})
			}
			previousReadOnlyRef.current = null
		}

		wasVersionPreviewRef.current = isVersionPreview
	}, [isVersionPreview, isReadOnly, setReadOnly, refreshReadOnlyState])

	return {
		isVersionPreview,
		versionLabel,
		versionSourceLabel,
		exitVersionPreview,
		handleRestoreVersion,
		handleExternalRestore,
		isRestoringVersion,
		currentVersionSource,
		currentFileVersion,
	}
}
