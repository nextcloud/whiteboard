/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@nextcloud/l10n'
import { getRequestToken } from '@nextcloud/auth'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useSyncStore } from '../stores/useSyncStore.ts'
import { db } from '../database/db'
import { fetchWhiteboardSnapshot } from '../utils/fetchWhiteboardSnapshot.ts'
import { mergeElementsWithMetadata } from '../utils/mergeElementsWithMetadata.ts'
import { restoreVersionElements } from '../utils/restoreVersionElements.ts'
import { computeElementVersionHash } from '../utils/syncSceneData'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import logger from '../utils/logger'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

import { generateUrl } from '@nextcloud/router'
import { SCENE_SCHEMA_VERSION } from '../utils/sceneSchema.ts'

type RestoredSnapshot = {
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState: Partial<AppState>
	scrollToContent: boolean
}

type ParsedVersionContent = {
	elements?: unknown
	files?: unknown
	appState?: unknown
	scrollToContent?: boolean
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

	const captureRestoredSnapshot = useCallback(async (sourceOverride: string | null, currentElements: readonly ExcalidrawElement[]): Promise<RestoredSnapshot | null> => {
		try {
			if (!sourceOverride && excalidrawAPI) {
				const rawElements = excalidrawAPI.getSceneElementsIncludingDeleted?.() || []
				const sanitizedElements = restoreVersionElements(rawElements, currentElements)
				const rawFiles = excalidrawAPI.getFiles?.() || {}
				const filesCopy: BinaryFiles = { ...rawFiles }
				const rawAppState = excalidrawAPI.getAppState?.() || {}
				const appStateCopy = sanitizeAppStateForSync(rawAppState)
				appStateCopy.viewModeEnabled = false
				const scrollToContent = typeof rawAppState.scrollToContent === 'boolean'
					? rawAppState.scrollToContent
					: true

				return {
					elements: sanitizedElements,
					files: filesCopy,
					appState: appStateCopy,
					scrollToContent,
				}
			}

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
						elements: restoreVersionElements([], currentElements),
						files: {},
						appState: {},
						scrollToContent: true,
					}
				}

				let parsedContent: ParsedVersionContent | null = null
				try {
					parsedContent = JSON.parse(rawContent) as ParsedVersionContent
				} catch (error) {
					throw new Error('Failed to parse version content JSON')
				}

				if (!parsedContent || !Array.isArray(parsedContent.elements)) {
					throw new Error('Version content is missing elements array')
				}

				const sanitizedElements = restoreVersionElements(parsedContent.elements as ExcalidrawElement[], currentElements)
				const rawFiles = (parsedContent.files && typeof parsedContent.files === 'object')
					? parsedContent.files
					: {}
				const files = rawFiles as BinaryFiles
				const rawAppState = (parsedContent.appState && typeof parsedContent.appState === 'object')
					? parsedContent.appState
					: {}
				const parsedAppState = sanitizeAppStateForSync(rawAppState)
				const appStateCopy: Partial<AppState> = { ...parsedAppState }
				appStateCopy.viewModeEnabled = false

				return {
					elements: sanitizedElements,
					files,
					appState: appStateCopy,
					scrollToContent: parsedContent.scrollToContent ?? true,
				}
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to capture restored snapshot', error)
			return null
		}

		return null
	}, [excalidrawAPI, currentVersionSource])

	const readCurrentElements = useCallback(async (): Promise<readonly ExcalidrawElement[]> => {
		const jwt = await getJWT()
		if (!jwt) {
			throw new Error('Missing JWT')
		}
		const stored = await fetchWhiteboardSnapshot(fileId, jwt)
		// A version preview shows the version, the board itself stays in the local copy
		const localElements = isVersionPreview
			? (await db.get(fileId))?.elements ?? []
			: excalidrawAPI?.getSceneElementsIncludingDeleted() ?? []

		return [...localElements, ...stored.elements as ExcalidrawElement[]]
	}, [getJWT, fileId, isVersionPreview, excalidrawAPI])

	const applySnapshotToScene = useCallback((snapshot: RestoredSnapshot | null) => {
		if (!snapshot || !excalidrawAPI) {
			return
		}

		const { elements, files, appState, scrollToContent } = snapshot
		const sanitizedAppState: Partial<AppState> = {
			...sanitizeAppStateForSync(appState),
			viewModeEnabled: false,
		}

		excalidrawAPI.addFiles(Object.values(files || {}))
		excalidrawAPI.updateScene?.({
			elements: mergeElementsWithMetadata(excalidrawAPI.getSceneElementsIncludingDeleted(), elements, excalidrawAPI.getAppState()),
			appState: {
				...sanitizedAppState,
				scrollToContent,
			},
		})
	}, [excalidrawAPI])

	// Without a connection, the scene sync sends the restored elements once the session is back in the room
	const broadcastSnapshotToSocket = useCallback((snapshot: RestoredSnapshot) => {
		const { socket: currentSocket, isInRoom } = useCollaborationStore.getState()
		if (!currentSocket?.connected || !fileId || !isInRoom) {
			return
		}

		try {
			const encoder = new TextEncoder()
			// An ordinary scene update: the restored elements carry versions above the copies they replace
			const scenePayload = {
				type: 'SCENE_UPDATE',
				schemaVersion: SCENE_SCHEMA_VERSION,
				payload: { elements: snapshot.elements },
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
		} catch (error) {
			logger.error('[useVersionPreview] Failed to broadcast restored version over socket', error)
		}
	}, [fileId])

	const persistRestoredSnapshot = useCallback(async (snapshot: RestoredSnapshot) => {
		if (!Number.isFinite(fileId) || fileId <= 0) {
			return
		}

		const { elements, files, appState, scrollToContent } = snapshot
		const sanitizedAppState: Partial<AppState> = {
			...sanitizeAppStateForSync(appState),
			viewModeEnabled: false,
		}
		const filesToStore: BinaryFiles = files || {}

		let saved = false
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
							elements,
							files: filesToStore,
							appState: sanitizedAppState,
							scrollToContent,
						},
						schemaVersion: SCENE_SCHEMA_VERSION,
					}),
				})

				if (!response.ok) {
					throw new Error(`Unexpected status ${response.status}`)
				}
				saved = true
			} else {
				logger.warn('[useVersionPreview] Skipping server sync for restored version due to missing JWT')
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to sync restored version to server', error)
		}

		// Pending when the server did not store it, so that the next load keeps it over the stored board
		await db.put(
			fileId,
			elements,
			filesToStore,
			sanitizedAppState,
			{
				hasPendingLocalChanges: !saved,
				lastSyncedHash: computeElementVersionHash(elements),
			},
		)

		broadcastSnapshotToSocket({
			elements,
			files: filesToStore,
			appState: sanitizedAppState,
			scrollToContent,
		})
	}, [fileId, getJWT, broadcastSnapshotToSocket])

	const handleRestoreVersion = useCallback(async () => {
		if (!versionDavEndpoints) {
			showError(t('whiteboard', 'Could not restore this version'))
			return
		}

		setIsRestoringVersion(true)
		try {
			// A save of the board landing after the restore would replace it
			await useSyncStore.getState().pauseSaves(fileId)
			const snapshot = await captureRestoredSnapshot(null, await readCurrentElements())
			if (!snapshot) {
				throw new Error('Could not read the version')
			}

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

			await persistRestoredSnapshot(snapshot)
			// Merged with what arrived meanwhile, and saved like any other change
			useSyncStore.getState().resumeSaves()
			applySnapshotToScene(snapshot)

			showSuccess(t('whiteboard', 'Version restored'))
			exitVersionPreview()
		} catch (error) {
			logger.error('[useVersionPreview] Failed to restore version', error)
			showError(t('whiteboard', 'Could not restore this version'))
		} finally {
			useSyncStore.getState().resumeSaves()
			setIsRestoringVersion(false)
		}
	}, [versionDavEndpoints, captureRestoredSnapshot, readCurrentElements, persistRestoredSnapshot, fileId, exitVersionPreview])

	const handleExternalRestore = useCallback(async (source: string, fileVersionId: string | null) => {
		const endpoints = resolveVersionEndpoints(source)

		if (!endpoints) {
			showError(t('whiteboard', 'Could not restore this version'))
			logger.error('[useVersionPreview] Missing endpoints for external restore', { source, fileVersionId })
			return false
		}

		setIsRestoringVersion(true)
		try {
			// A save of the board landing after the restore would replace it
			await useSyncStore.getState().pauseSaves(fileId)
			const snapshot = await captureRestoredSnapshot(source, await readCurrentElements())
			if (!snapshot) {
				throw new Error('Could not read the version')
			}

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

			await persistRestoredSnapshot(snapshot)
			// Merged with what arrived meanwhile, and saved like any other change
			useSyncStore.getState().resumeSaves()
			applySnapshotToScene(snapshot)

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
			useSyncStore.getState().resumeSaves()
			setIsRestoringVersion(false)
		}
	}, [captureRestoredSnapshot, readCurrentElements, currentVersionSource, exitVersionPreview, fileId, isVersionPreview, persistRestoredSnapshot, refreshReadOnlyState, resolveVersionEndpoints, setReadOnly])

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
