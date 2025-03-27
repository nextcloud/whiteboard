/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState, useCallback } from 'react'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { useSyncStore } from '../stores/useSyncStore'
import { useCollaboration } from './useCollaboration'

export function useWhiteboard() {
	const [isLoading, setIsLoading] = useState(true)
	const [viewModeEnabled, setViewModeEnabled] = useState(false)

	const { fileId } = useWhiteboardStore.getState()

	const {
		initialDataPromise,
		initializeData,
		saveToLocalStorage,
		isReadOnly,
		isDedicatedSyncer,
	} = useWhiteboardStore()

	const {
		localSyncStatus,
		serverSyncStatus,
		pendingServerSync,
		syncToServer,
	} = useSyncStore()
	const syncStatus
		= localSyncStatus === 'syncing' || serverSyncStatus === 'syncing'
			? 'syncing'
			: localSyncStatus === 'error' || serverSyncStatus === 'error'
				? 'error'
				: 'idle'

	const { excalidrawAPI } = useExcalidrawStore()

	const {
		onPointerUpdate,
		scrollToContent,
		isConnected,
	} = useCollaboration(setViewModeEnabled)

	useEffect(() => {
		if (fileId) {
			initializeData()
			setIsLoading(false)
		}
	}, [fileId, initializeData])

	useEffect(() => {
		if (excalidrawAPI && !isLoading) {
			saveToLocalStorage(
				excalidrawAPI.getSceneElements() as any,
				excalidrawAPI.getAppState() as any,
				excalidrawAPI.getFiles() as any,
			)
		}
	}, [excalidrawAPI, isLoading, saveToLocalStorage])

	const onChange = useCallback(
		(elements: any, appState: any, files: any) => {
			saveToLocalStorage(elements, appState, files)
		},
		[saveToLocalStorage],
	)

	useEffect(() => {
		const handleBeforeUnload = () => {
			if (excalidrawAPI && !isReadOnly) {
				const currentElements = excalidrawAPI.getSceneElements() as any
				const currentAppState = excalidrawAPI.getAppState() as any
				const currentFiles = excalidrawAPI.getFiles() as any

				saveToLocalStorage(
					currentElements,
					currentAppState,
					currentFiles,
				)
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
		}
	}, [excalidrawAPI, isReadOnly, saveToLocalStorage])

	useEffect(() => {
		if (
			isDedicatedSyncer
			&& pendingServerSync
			&& serverSyncStatus !== 'syncing'
		) {
			console.log(
				'[Whiteboard] Periodic server sync - pending changes detected',
			)
			const interval = setInterval(() => {
				if (serverSyncStatus !== 'syncing') {
					syncToServer()
				}
			}, 3000)

			return () => clearInterval(interval)
		}
	}, [isDedicatedSyncer, serverSyncStatus, pendingServerSync, syncToServer])

	useEffect(() => {
		const handleOnline = () => {
			console.log(
				'[Network] Connection restored, checking for pending syncs',
			)
			if (
				isDedicatedSyncer
				&& pendingServerSync
				&& serverSyncStatus !== 'syncing'
			) {
				setTimeout(() => syncToServer(), 3000)
			}
		}

		window.addEventListener('online', handleOnline)
		return () => window.removeEventListener('online', handleOnline)
	}, [isDedicatedSyncer, pendingServerSync, serverSyncStatus, syncToServer])

	return {
		initialDataPromise,
		isLoading,
		syncStatus,
		pendingServerSync,
		isConnected,
		isDedicatedSyncer,
		onChange,
		onPointerUpdate,
		scrollToContent,
		viewModeEnabled,
	}
}
