/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useEffect, useRef } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { getRequestToken } from '@nextcloud/auth'
import { useJWTStore } from '../stores/jwtStore'
import { db } from '../database/db'
import { reconcileElements } from '../collaboration/util'

const SYNC_INTERVAL = 10000 // 10 seconds

export function useWhiteboardData(
	fileId: number,
	publicSharingToken: string | null,
	excalidrawAPI: ExcalidrawImperativeAPI | null,
) {
	const { getJWT } = useJWTStore()

	const [isLoading, setIsLoading] = useState(true)

	// Use refs to track component state
	const isSyncingRef = useRef(false)
	const isMountedRef = useRef(true)
	const pendingSyncRef = useRef(false)

	// Add cleanup effect
	useEffect(() => {
		return () => {
			isMountedRef.current = false
		}
	}, [])

	// Load data when excalidrawAPI becomes available
	useEffect(() => {
		const loadData = async () => {
			if (!excalidrawAPI || !isMountedRef.current) return

			setIsLoading(true)

			try {
				await loadLocalData()
				await loadServerData()
			} catch (error) {
				console.error('Error loading whiteboard data:', error)
			} finally {
				setIsLoading(false)
			}
		}

		if (excalidrawAPI) {
			loadData()
		}
	}, [excalidrawAPI, fileId])

	const loadLocalData = async () => {
		if (!excalidrawAPI || !isMountedRef.current) return

		try {
			const localData = await db.getWhiteboardData(fileId)
			if (localData && isMountedRef.current) {
				excalidrawAPI.updateScene({
					elements: localData.elements,
				})
			}
		} catch (error) {
			console.error('Error loading local data:', error)
		}
	}

	const loadServerData = async () => {
		if (!excalidrawAPI || !isMountedRef.current) return

		try {
			const token = await getJWT(`${fileId}`, publicSharingToken)
			if (!token) {
				throw new Error('Could not get authentication token')
			}

			let url = generateUrl(`apps/whiteboard/${fileId}`)
			if (publicSharingToken) {
				url += `?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
			}

			const response = await axios.get(url, {
				withCredentials: true,
				headers: {
					'X-Requested-With': 'XMLHttpRequest',
					requesttoken: getRequestToken(),
					Authorization: `Bearer ${token}`,
				},
			})

			const serverData = response.data.data

			if (serverData && serverData.elements && isMountedRef.current) {
				const reconciledElements = reconcileElements(
					excalidrawAPI.getSceneElements(),
					serverData.elements,
					excalidrawAPI.getAppState(),
				)

				excalidrawAPI.updateScene({
					elements: reconciledElements,
				})
			}
		} catch (error) {
			console.error('Error fetching from server:', error)
			throw error
		}
	}

	useEffect(() => {
		if (!isLoading) {
			const interval = setInterval(() => {
				if (pendingSyncRef.current) {
					syncToServer()
				}
			}, SYNC_INTERVAL)

			return () => {
				clearInterval(interval)
			}
		}
	}, [isLoading])

	const syncToServer = async () => {
		if (isSyncingRef.current) {
			return
		}

		isSyncingRef.current = true

		try {
			const token = await getJWT(`${fileId}`, publicSharingToken)

			if (!token) {
				throw new Error('Could not get authentication token')
			}

			// Save to server
			let url = generateUrl(`apps/whiteboard/${fileId}`)
			if (publicSharingToken) {
				url += `?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
			}

			await axios.put(url, db.getWhiteboardData(fileId), {
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${token}`,
					requesttoken: getRequestToken(),
				},
			})
			pendingSyncRef.current = false
		} catch (error) {
			console.error('Error syncing to server:', error)
		} finally {
			isSyncingRef.current = false
		}
	}

	const updateLocalData = async (elements: any, files: any) => {
		console.log('updateLocalData', elements, files)
		await db.saveWhiteboardData(fileId, elements, files)
	}

	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}

		let updateTimeout: NodeJS.Timeout | null = null

		const debouncedUpdate = (elements: any, files: any) => {
			if (updateTimeout) clearTimeout(updateTimeout)

			updateTimeout = setTimeout(() => {
				updateLocalData(elements, files)
			}, 2000)
		}

		excalidrawAPI.onChange((elements, _, files) => {
			debouncedUpdate(elements, files)
		})

		const handleBeforeUnload = () => {
			if (excalidrawAPI) {
				const currentElements = excalidrawAPI.getSceneElements()
				const currentFiles = excalidrawAPI.getFiles()

				updateLocalData(currentElements, currentFiles)
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			if (updateTimeout) clearTimeout(updateTimeout)
			window.removeEventListener('beforeunload', handleBeforeUnload)
		}
	}, [excalidrawAPI, updateLocalData])
}
