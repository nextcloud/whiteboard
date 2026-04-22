/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { reconcileElements as excalidrawReconcileElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState } from '@excalidraw/excalidraw/types/types'
import type { WhiteboardElement } from '../types/whiteboard'

/**
 * Reconciles elements while preserving creator metadata coming from the server.
 * @param localElements - The local elements from the client
 * @param remoteElements - The remote elements from the server
 * @param appState - The current application state
 */
export function mergeElementsWithMetadata(
	localElements: readonly ExcalidrawElement[],
	remoteElements: readonly ExcalidrawElement[],
	appState: AppState,
): ExcalidrawElement[] {
	// First, do the standard Excalidraw reconciliation
	const reconciledElements = excalidrawReconcileElements(
		localElements,
		remoteElements,
		appState,
	)

	// Create maps for quick lookup
	const localElementsMap = new Map<string, WhiteboardElement>()
	const remoteElementsMap = new Map<string, WhiteboardElement>()

	localElements.forEach(el => {
		localElementsMap.set(el.id, el as WhiteboardElement)
	})

	remoteElements.forEach(el => {
		remoteElementsMap.set(el.id, el as WhiteboardElement)
	})

	// Preserve custom data (creator info) from remote elements
	const finalElements = reconciledElements.map(element => {
		const whiteboardElement = element as WhiteboardElement
		const remoteElement = remoteElementsMap.get(element.id)
		const localElement = localElementsMap.get(element.id)
		const customData = { ...(whiteboardElement.customData || {}) }
		let hasCustomDataChanges = false

		// If remote element has creator info, preserve it
		if (remoteElement?.customData?.creator) {
			customData.creator = remoteElement.customData.creator
			hasCustomDataChanges = true
		}

		// If remote element has lastModifiedBy info, check if it's newer
		if (remoteElement?.customData?.lastModifiedBy) {
			const remoteModTime = remoteElement.customData.lastModifiedBy.createdAt
			const localModTime = localElement?.customData?.lastModifiedBy?.createdAt || 0

			if (remoteModTime > localModTime) {
				customData.lastModifiedBy = remoteElement.customData.lastModifiedBy
				hasCustomDataChanges = true
			}
		}

		// If local element had creator info but remote doesn't, preserve local
		if (localElement?.customData?.creator && !whiteboardElement.customData?.creator) {
			customData.creator = localElement.customData.creator
			hasCustomDataChanges = true
		}

		// Preserve table-specific custom data from whichever version won reconciliation
		// This ensures tableHtml, isTable, and tableLock are not lost
		const sourceElement = remoteElement || localElement
		if (sourceElement?.customData) {
			// Preserve table metadata
			if (sourceElement.customData.isTable !== undefined) {
				customData.isTable = sourceElement.customData.isTable
				hasCustomDataChanges = true
			}
			if (sourceElement.customData.tableHtml !== undefined) {
				customData.tableHtml = sourceElement.customData.tableHtml
				hasCustomDataChanges = true
			}
			// Preserve or clear lock status from the source element
			if ('tableLock' in sourceElement.customData) {
				customData.tableLock = sourceElement.customData.tableLock
				hasCustomDataChanges = true
			}
		}

		if (!hasCustomDataChanges) {
			return whiteboardElement
		}

		return {
			...whiteboardElement,
			customData,
		}
	})

	return finalElements
}
