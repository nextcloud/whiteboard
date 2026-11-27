/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showError, showSuccess } from '@nextcloud/dialogs'
import { subscribe, unsubscribe } from '@nextcloud/event-bus'
import { t } from '@nextcloud/l10n'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { getBoardSync } from '../sync/boardSync.ts'
import { announce, showBoard } from '../sync/createBoardSync.ts'
import logger from '../utils/logger'
import { restoreThroughNextcloud } from '../utils/versionRestore.ts'

interface UseVersionPreviewOptions {
	fileId: number
	versionSource: string | null
	fileVersion: string | null
	refreshReadOnlyState: () => Promise<boolean>
	isReadOnly: boolean
}

export function useVersionPreview({
	fileId,
	versionSource,
	fileVersion,
	refreshReadOnlyState,
	isReadOnly,
}: UseVersionPreviewOptions) {
	const { setConfig, setReadOnly } = useWhiteboardConfigStore(useShallow((state) => ({
		setConfig: state.setConfig,
		setReadOnly: state.setReadOnly,
	})))

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

	// Nextcloud restores the version as Files does; the board opens it in a new epoch and tabs in the room fetch it
	const handleRestoreVersion = useCallback(async () => {
		if (!currentVersionSource) {
			return
		}
		setIsRestoringVersion(true)
		try {
			await restoreThroughNextcloud(currentVersionSource)
			// The live board is closed in the preview; the room fetches the restored one
			announce(fileId, 'restored')
			showSuccess(t('whiteboard', 'Version restored'))
			exitVersionPreview()
		} catch (error) {
			logger.error('[useVersionPreview] Failed to restore version', error)
			showError(t('whiteboard', 'Could not restore this version'))
		} finally {
			setIsRestoringVersion(false)
		}
	}, [currentVersionSource, fileId, exitVersionPreview])

	useEffect(() => {
		// Files restored a version of this board: show it now and tell the room
		const onRestored = (event: unknown) => {
			const payload = event as { node?: { fileid?: number }, version?: { fileId?: number }, fileId?: number } | null
			// Nextcloud 33 and later send the node and the version, 31 and 32 the version alone
			if (Number(payload?.node?.fileid ?? payload?.version?.fileId ?? payload?.fileId) === fileId) {
				void getBoardSync()?.restored()
			}
		}
		subscribe('files_versions:restore:restored', onRestored)
		return () => unsubscribe('files_versions:restore:restored', onRestored)
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
				// The live board closes while it can still save what it has not
				showBoard(null)
			}
			setReadOnly(true)
		} else if (wasVersionPreview) {
			if (previousReadOnlyRef.current !== null) {
				setReadOnly(previousReadOnlyRef.current)
			} else {
				refreshReadOnlyState().catch((error) => {
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
