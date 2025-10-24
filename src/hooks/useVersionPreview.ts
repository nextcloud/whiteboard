/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@nextcloud/l10n'
import { restoreElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import { db } from '../database/db'
import { hashElementsVersion } from '../util'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import logger from '../logger'

// @ts-expect-error - Type definitions issue with @nextcloud/router
import { generateUrl } from '@nextcloud/router'

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
		try {
			const resolvedUrl = new URL(currentVersionSource, window.location.origin)
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
			logger.error('[useVersionPreview] Failed to resolve versionSource endpoint', { error, versionSource: currentVersionSource })
			return null
		}
	}, [isVersionPreview, currentVersionSource])

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

	const captureRestoredSnapshot = useCallback(async (): Promise<RestoredSnapshot | null> => {
		try {
			if (excalidrawAPI) {
				const rawElements = excalidrawAPI.getSceneElementsIncludingDeleted?.() || []
				const sanitizedElements = restoreElements(rawElements, null) as ExcalidrawElement[]
				const rawFiles = excalidrawAPI.getFiles?.() || {}
				const filesCopy: BinaryFiles = { ...rawFiles }
				const rawAppState = excalidrawAPI.getAppState?.() || {}
				const appStateCopy: Partial<AppState> = { ...rawAppState }
				delete appStateCopy.collaborators
				delete appStateCopy.selectedElementIds
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

			if (currentVersionSource) {
				const response = await fetch(currentVersionSource, {
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

				const sanitizedElements = restoreElements(parsedContent.elements as ExcalidrawElement[], null) as ExcalidrawElement[]
				const rawFiles = (parsedContent.files && typeof parsedContent.files === 'object')
					? parsedContent.files
					: {}
				const files = rawFiles as BinaryFiles
				const rawAppState = (parsedContent.appState && typeof parsedContent.appState === 'object')
					? parsedContent.appState
					: {}
				const parsedAppState = rawAppState as Partial<AppState>
				const appStateCopy: Partial<AppState> = { ...parsedAppState }
				delete appStateCopy.collaborators
				delete appStateCopy.selectedElementIds

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

	const persistRestoredSnapshot = useCallback(async (snapshot: RestoredSnapshot) => {
		if (!Number.isFinite(fileId) || fileId <= 0) {
			return
		}

		const { elements, files, appState, scrollToContent } = snapshot
		const sanitizedAppState: Partial<AppState> = { ...appState }
		delete sanitizedAppState.collaborators
		delete sanitizedAppState.selectedElementIds
		const filesToStore: BinaryFiles = files || {}

		await db.put(
			fileId,
			elements,
			filesToStore,
			sanitizedAppState,
			{
				hasPendingLocalChanges: false,
				lastSyncedHash: hashElementsVersion(elements),
			},
		)

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
					}),
				})

				if (!response.ok && response.status !== 409) {
					throw new Error(`Unexpected status ${response.status}`)
				}
			} else {
				logger.warn('[useVersionPreview] Skipping server sync for restored version due to missing JWT')
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to sync restored version to server', error)
		}

		const currentSocket = useCollaborationStore.getState().socket
		if (currentSocket?.connected) {
			try {
				const encoder = new TextEncoder()
				const scenePayload = {
					type: 'SCENE_RESTORE',
					payload: {
						elements,
						files: filesToStore,
						appState: sanitizedAppState,
						scrollToContent,
					},
				}
				currentSocket.emit('server-broadcast', `${fileId}`, encoder.encode(JSON.stringify(scenePayload)), [])

				const fileValues = filesToStore ? Object.values(filesToStore) : []
				fileValues.forEach(file => {
					const filePayload = {
						type: 'IMAGE_ADD',
						payload: { file },
					}
					currentSocket.emit('server-broadcast', `${fileId}`, encoder.encode(JSON.stringify(filePayload)), [])
				})
			} catch (error) {
				logger.error('[useVersionPreview] Failed to broadcast restored version over socket', error)
			}
		}
	}, [fileId, getJWT])

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
					'OCS-APIREQUEST': 'true',
				},
			})

			if (!response.ok) {
				throw new Error(`Unexpected status ${response.status}`)
			}

			if (snapshot) {
				await persistRestoredSnapshot(snapshot)
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
		isRestoringVersion,
		currentVersionSource,
		currentFileVersion,
	}
}
