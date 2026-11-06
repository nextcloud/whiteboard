/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@nextcloud/l10n'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import { getBoardSync, setBoardSync } from '../sync/boardSync.ts'
import logger from '../utils/logger'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

import { generateUrl } from '@nextcloud/router'
import { SCENE_SCHEMA_VERSION, sceneNotice } from '../utils/sceneSchema.ts'

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

	// The version as it was stored; its epoch makes it win over every copy that existed before
	const captureRestoredSnapshot = useCallback(async (sourceOverride: string | null): Promise<RestoredSnapshot | null> => {
		try {
			if (!sourceOverride && excalidrawAPI) {
				const appStateCopy = sanitizeAppStateForSync(excalidrawAPI.getAppState())
				appStateCopy.viewModeEnabled = false
				return {
					elements: [...excalidrawAPI.getSceneElementsIncludingDeleted()],
					files: { ...excalidrawAPI.getFiles() },
					appState: appStateCopy,
					scrollToContent: true,
				}
			}

			const effectiveSource = sourceOverride ?? currentVersionSource
			if (!effectiveSource) {
				return null
			}
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
				return { elements: [], files: {}, appState: {}, scrollToContent: true }
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

			const appStateCopy: Partial<AppState> = { ...sanitizeAppStateForSync((parsedContent.appState && typeof parsedContent.appState === 'object') ? parsedContent.appState : {}) }
			appStateCopy.viewModeEnabled = false
			return {
				elements: parsedContent.elements as ExcalidrawElement[],
				files: ((parsedContent.files && typeof parsedContent.files === 'object') ? parsedContent.files : {}) as BinaryFiles,
				appState: appStateCopy,
				scrollToContent: parsedContent.scrollToContent ?? true,
			}
		} catch (error) {
			logger.error('[useVersionPreview] Failed to capture restored snapshot', error)
			return null
		}
	}, [excalidrawAPI, currentVersionSource])

	// Writes the version as the board in a new epoch. An open board shows it at
	// once; tabs in the room fetch it.
	const restoreSnapshot = useCallback(async (snapshot: RestoredSnapshot) => {
		const boardSync = getBoardSync()
		// Reading the version took a while and another board opened meanwhile
		if (boardSync && boardSync.fileId !== fileId) {
			throw new Error('Another board is open')
		}
		if (boardSync) {
			await boardSync.restore(snapshot)
			return
		}

		const jwt = await getJWT()
		if (!jwt) {
			throw new Error('Missing JWT')
		}
		const response = await fetch(generateUrl(`apps/whiteboard/${fileId}/restore`), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				Authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({ schemaVersion: SCENE_SCHEMA_VERSION, data: snapshot }),
		})
		if (!response.ok) {
			throw new Error(`Unexpected status ${response.status}`)
		}
		const { sync } = await response.json()
		const { socket, isInRoom } = useCollaborationStore.getState()
		if (socket?.connected && isInRoom) {
			socket.emit('server-broadcast', `${fileId}`, new TextEncoder().encode(JSON.stringify(sceneNotice('restored', sync))), [])
		}
	}, [fileId, getJWT])

	const handleRestoreVersion = useCallback(async () => {
		setIsRestoringVersion(true)
		try {
			const snapshot = await captureRestoredSnapshot(null)
			if (!snapshot) {
				throw new Error('Could not read the version')
			}
			await restoreSnapshot(snapshot)
			showSuccess(t('whiteboard', 'Version restored'))
			exitVersionPreview()
		} catch (error) {
			logger.error('[useVersionPreview] Failed to restore version', error)
			showError(t('whiteboard', 'Could not restore this version'))
		} finally {
			setIsRestoringVersion(false)
		}
	}, [captureRestoredSnapshot, restoreSnapshot, exitVersionPreview])

	const handleExternalRestore = useCallback(async (source: string, fileVersionId: string | null) => {
		setIsRestoringVersion(true)
		try {
			const snapshot = await captureRestoredSnapshot(source)
			if (!snapshot) {
				throw new Error('Could not read the version')
			}
			await restoreSnapshot(snapshot)
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
			logger.error('[useVersionPreview] Failed to restore version from sidebar', { error, source, fileVersionId })
			showError(t('whiteboard', 'Could not restore this version'))
			return false
		} finally {
			setIsRestoringVersion(false)
		}
	}, [captureRestoredSnapshot, restoreSnapshot, currentVersionSource, exitVersionPreview, isVersionPreview, refreshReadOnlyState, setReadOnly])

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
				// The live board closes while it can still save what it has not
				setBoardSync(null)
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
