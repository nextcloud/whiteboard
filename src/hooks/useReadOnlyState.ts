/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useEffect, useCallback } from 'react'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useJWTStore } from '../stores/useJwtStore'

export function useReadOnlyState() {
	const { excalidrawAPI } = useExcalidrawStore()
	const { isReadOnly, setReadOnly } = useWhiteboardConfigStore()
	const { getJWT, parseJwt } = useJWTStore()

	// Update read-only state based on JWT
	const updateReadOnlyState = useCallback((readOnly: boolean) => {
		// Set the read-only state in the store
		setReadOnly(readOnly)
		console.log(`[Permissions] User has ${readOnly ? 'read-only' : 'write'} access`)

		// If we have the Excalidraw API, update the view mode directly as well
		// This ensures immediate effect even before the next render
		if (excalidrawAPI) {
			try {
				// Get current view mode state
				const currentViewMode = excalidrawAPI.getAppState().viewModeEnabled

				// If read-only is true, ensure view mode is enabled
				if (readOnly && !currentViewMode) {
					console.log('[Permissions] Enabling view mode via Excalidraw API')
					excalidrawAPI.updateScene({
						appState: { viewModeEnabled: true },
					})
				} else if (!readOnly && currentViewMode) {
					// If not read-only but view mode is enabled, disable it
					console.log('[Permissions] Disabling view mode via Excalidraw API')
					excalidrawAPI.updateScene({
						appState: { viewModeEnabled: false },
					})
				}
			} catch (error) {
				console.error('[Permissions] Error updating view mode via Excalidraw API:', error)
			}
		}
	}, [excalidrawAPI, setReadOnly])

	// Refresh read-only state from JWT
	const refreshReadOnlyState = useCallback(async () => {
		// Get the current fileId
		const { fileId } = useWhiteboardConfigStore.getState()

		// Check if fileId is valid before proceeding
		if (!fileId) {
			console.warn('[Permissions] Cannot refresh read-only state: invalid fileId', fileId)
			return false
		}

		try {
			const token = await getJWT()
			if (token) {
				const parsedToken = parseJwt(token)
				if (parsedToken && parsedToken.isFileReadOnly !== undefined) {
					console.log(`[Permissions] JWT indicates ${parsedToken.isFileReadOnly ? 'read-only' : 'write'} access`)
					updateReadOnlyState(parsedToken.isFileReadOnly)
					return true
				}
			}
		} catch (error) {
			console.error('[Permissions] Error refreshing read-only state:', error)
		}
		return false
	}, [getJWT, parseJwt, updateReadOnlyState])

	// Apply read-only state when Excalidraw API becomes available
	useEffect(() => {
		if (excalidrawAPI) {
			console.log(`[Permissions] Excalidraw API available, applying current read-only state: ${isReadOnly}`)

			// Apply the current read-only state
			updateReadOnlyState(isReadOnly)

			// Get the current fileId
			const { fileId } = useWhiteboardConfigStore.getState()

			// Only refresh from JWT if fileId is valid
			if (fileId) {
				console.log(`[Permissions] Refreshing from JWT with fileId: ${fileId}`)
				refreshReadOnlyState()
			} else {
				console.warn('[Permissions] Skipping JWT refresh due to invalid fileId')
			}
		}
	}, [excalidrawAPI, isReadOnly, updateReadOnlyState, refreshReadOnlyState])

	// Initial setup - refresh read-only state from JWT
	useEffect(() => {
		// Get the current fileId
		const { fileId } = useWhiteboardConfigStore.getState()

		// Only refresh if fileId is valid
		if (fileId) {
			console.log(`[Permissions] Initial setup with fileId: ${fileId}`)
			refreshReadOnlyState()
		} else {
			console.warn('[Permissions] Skipping initial JWT refresh due to invalid fileId')
		}
	}, [refreshReadOnlyState])

	return {
		isReadOnly,
		updateReadOnlyState,
		refreshReadOnlyState,
	}
}
