/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useCallback, useRef, useMemo } from 'react'
import type {
	BinaryFiles,
	ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { getRequestToken } from '@nextcloud/auth'
import { useJWTStore } from '../stores/useJwtStore'
import { db } from '../database/db'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { throttle } from 'lodash'
import { useWhiteboardStore } from '../stores/useWhiteboardStore'
import { resolvablePromise } from '../utils'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'

const SYNC_INTERVAL = 60000
const DEBOUNCE_TIMEOUT = 3000

export function useWhiteboardData(
	fileId: number,
	publicSharingToken: string | null,
) {
	const initialDataState = useMemo(() => ({
		appState: {
			currentItemFontFamily: 3,
			currentItemStrokeWidth: 1,
			currentItemRoughness: 0,
		},
	}), [])

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>
	}>({ promise: null! })

	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
		initialStatePromiseRef.current.promise.resolve(initialDataState)
	}

	const { executeWithJWT } = useJWTStore()
	const { excalidrawAPI, scrollToContent } = useExcalidrawStore()
	const { status, pendingSync, setStatus, setPendingSync }
		= useWhiteboardStore()

	// Use refs to maintain latest values in callbacks without recreating them
	const statusRef = useRef(status)
	const pendingSyncRef = useRef(pendingSync)

	useEffect(() => {
		statusRef.current = status
		pendingSyncRef.current = pendingSync
	}, [status, pendingSync])

	const loadLocalData = useCallback(async () => {
		if (!excalidrawAPI) return

		try {
			const localData = await db.getWhiteboardData(fileId)
			if (localData) {
				excalidrawAPI.updateScene({
					elements: localData.elements,
				})
			}
		} catch (error) {
			console.error('Error loading local data:', error)
		}
	}, [excalidrawAPI, fileId])

	useEffect(() => {
		const loadData = async () => {
			if (!excalidrawAPI) return

			setStatus('loading')

			try {
				await loadLocalData()
				scrollToContent()
			} catch (error) {
				console.error('Error loading whiteboard data:', error)
			} finally {
				setStatus('idle')
			}
		}

		if (excalidrawAPI) {
			loadData()
		}
	}, [excalidrawAPI, loadLocalData, setStatus, scrollToContent])

	// Memoize the syncToServer function to prevent recreation on every render
	const syncToServer = useCallback(async () => {
		if (statusRef.current === 'syncing') {
			return
		}

		setStatus('syncing')

		try {
			await executeWithJWT(
				`${fileId}`,
				publicSharingToken,
				async (token) => {
					let url = generateUrl(`apps/whiteboard/${fileId}/sync`)
					if (publicSharingToken) {
						url += `?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
					}

					const whiteboardData = await db.getWhiteboardData(fileId)

					if (!whiteboardData) {
						console.warn('No whiteboard data found to sync')
						return
					}

					return await axios.put(
						url,
						{ data: whiteboardData },
						{
							headers: {
								'Content-Type': 'application/json',
								'X-Requested-With': 'XMLHttpRequest',
								Authorization: `Bearer ${token}`,
								requesttoken: getRequestToken(),
							},
						},
					)
				},
			)

			setPendingSync(false)
		} catch (error) {
			console.error('Error syncing to server:', error)
		} finally {
			setStatus('idle')
		}
	}, [fileId, executeWithJWT, publicSharingToken, setStatus, setPendingSync])

	useEffect(() => {
		if (status !== 'loading') {
			const interval = setInterval(() => {
				if (pendingSyncRef.current) {
					syncToServer()
				}
			}, SYNC_INTERVAL)

			return () => {
				clearInterval(interval)
			}
		}
	}, [status, syncToServer])

	// Create a memoized version of updateLocalData that won't change on re-renders
	const updateLocalData = useMemo(() =>
		throttle(async (elements: ExcalidrawElement[], files: BinaryFiles) => {
			await db.saveWhiteboardData(fileId, elements, files)
			setPendingSync(true)
		}, DEBOUNCE_TIMEOUT),
	[fileId, setPendingSync],
	)

	useEffect(() => {
		if (!excalidrawAPI) return

		const handleChange = (
			elements: ExcalidrawElement[],
			_,
			files: BinaryFiles,
		) => {
			updateLocalData(elements, files)
		}

		excalidrawAPI.onChange(handleChange)

		const handleBeforeUnload = () => {
			if (excalidrawAPI) {
				// Cancel any pending debounced calls
				updateLocalData.flush()

				// Get current data
				const currentElements = excalidrawAPI.getSceneElements()
				const currentFiles = excalidrawAPI.getFiles()

				// Save synchronously
				db.saveWhiteboardData(fileId, currentElements, currentFiles)
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			// Cancel pending throttled calls when component unmounts
			updateLocalData.cancel()
		}
	}, [excalidrawAPI, updateLocalData, fileId])

	return { initialDataPromise: initialStatePromiseRef.current.promise }
}
