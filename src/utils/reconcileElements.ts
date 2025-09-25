/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { reconcileElements as excalidrawReconcileElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState } from '@excalidraw/excalidraw/types/types'
import type { WhiteboardElement } from '../types/whiteboard'

/**
 * Custom reconcileElements that preserves creator information
 * @param localElements - The local elements from the client
 * @param remoteElements - The remote elements from the server
 * @param appState - The current application state
 */
export function reconcileElements(
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

		// If remote element has creator info, preserve it
		if (remoteElement?.customData?.creator) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}
			whiteboardElement.customData.creator = remoteElement.customData.creator
		}

		// If remote element has lastModifiedBy info, check if it's newer
		if (remoteElement?.customData?.lastModifiedBy) {
			const remoteModTime = remoteElement.customData.lastModifiedBy.createdAt
			const localModTime = localElement?.customData?.lastModifiedBy?.createdAt || 0

			if (remoteModTime > localModTime) {
				if (!whiteboardElement.customData) {
					whiteboardElement.customData = {}
				}
				whiteboardElement.customData.lastModifiedBy = remoteElement.customData.lastModifiedBy
			}
		}

		// If local element had creator info but remote doesn't, preserve local
		if (localElement?.customData?.creator && !whiteboardElement.customData?.creator) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}
			whiteboardElement.customData.creator = localElement.customData.creator
		}

		return whiteboardElement
	})

	return finalElements
}
