/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { reconcileElements as excalidrawReconcileElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState } from '@excalidraw/excalidraw/types/types'
import type { WhiteboardElement } from '../types/whiteboard'

export function prepareDuplicatedElements(
	nextElements: readonly ExcalidrawElement[],
	previousElements: readonly ExcalidrawElement[],
	prepareElement: (element: ExcalidrawElement) => ExcalidrawElement,
): ExcalidrawElement[] {
	const previousElementIds = new Set(previousElements.map((element) => element.id))
	return nextElements.map((element) => previousElementIds.has(element.id) ? element : prepareElement(element))
}

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

		// Existing elements keep their locally trusted creator. New elements use
		// the creator attested by the collaboration server.
		const creatorSource = localElement
			?? (remoteElement?.customData?.creator ? remoteElement : undefined)
		const creator = creatorSource?.customData?.creator
		if (creator) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}
			whiteboardElement.customData.creator = creator
			if (typeof creatorSource?.customData?.creatorProof === 'string') {
				whiteboardElement.customData.creatorProof = creatorSource.customData.creatorProof
			} else {
				delete whiteboardElement.customData.creatorProof
			}
		} else if (localElement && whiteboardElement.customData) {
			delete whiteboardElement.customData.creator
			delete whiteboardElement.customData.creatorProof
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

		const aiGenerated = remoteElement?.customData?.aiGenerated
			?? localElement?.customData?.aiGenerated
			?? whiteboardElement.customData?.aiGenerated
		if (aiGenerated) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}
			whiteboardElement.customData.aiGenerated = aiGenerated
		}

		const aiDisclosureLabel = remoteElement?.customData?.aiDisclosureLabel
			?? localElement?.customData?.aiDisclosureLabel
			?? whiteboardElement.customData?.aiDisclosureLabel
		if (aiDisclosureLabel) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}
			whiteboardElement.customData.aiDisclosureLabel = aiDisclosureLabel
		}

		// Preserve table-specific custom data from whichever version won reconciliation
		// This ensures tableHtml, isTable, and tableLock are not lost
		const sourceElement = remoteElement || localElement
		if (sourceElement?.customData) {
			if (!whiteboardElement.customData) {
				whiteboardElement.customData = {}
			}

			// Preserve table metadata
			if (sourceElement.customData.isTable !== undefined) {
				whiteboardElement.customData.isTable = sourceElement.customData.isTable
			}
			if (sourceElement.customData.tableHtml !== undefined) {
				whiteboardElement.customData.tableHtml = sourceElement.customData.tableHtml
			}
			// Preserve or clear lock status from the source element
			if ('tableLock' in sourceElement.customData) {
				whiteboardElement.customData.tableLock = sourceElement.customData.tableLock
			}
		}

		return whiteboardElement
	})

	return finalElements
}
