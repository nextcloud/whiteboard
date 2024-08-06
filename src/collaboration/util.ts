/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState } from '@excalidraw/excalidraw/types/types'
import { isObject } from 'lodash'

/**
 * Hashes elements' versionNonce (using djb2 algo). Order of elements matters.
 * @param elements all Elements
 */
export const hashElementsVersion = (
	elements: readonly ExcalidrawElement[],
): number => {
	return elements.reduce((acc, el) => acc + el.version, 0)
}

/**
 *
 * @param obj1 object 1 to compare
 * @param obj2 object 2 to compare
 * @param exceptions keys that are not required to be equal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDeepEqual(obj1:any, obj2: any, exceptions: Array<string>) {

	const keys1 = Object.keys(obj1)
	const keys2 = Object.keys(obj2)

	if (keys1.length !== keys2.length) return false

	for (const key of keys1) {
		const val1 = obj1[key]
		const val2 = obj2[key]

		const areObjects = isObject(val1) && isObject(val2)

		if ((areObjects && !isDeepEqual(val1, val2, exceptions)) || (!areObjects && val1 !== val2)) {
			if (!exceptions.includes(key)) {
				return false
			}
		}
	}
	return true
}

/**
 * decides if remote or local element should be kept
 * @param localAppState state of the app
 * @param localElement element of local state
 * @param remoteElement remote received element
 */
export function shouldDiscardRemoteElement(localAppState: Readonly<AppState>, localElement: ExcalidrawElement | undefined, remoteElement: ExcalidrawElement) {
	if (
		localElement
        // local element is being edited
        && (localElement.id === localAppState.editingElement?.id
          || localElement.id === localAppState.resizingElement?.id
          || localElement.id === localAppState.draggingElement?.id // TODO: Is this still valid? As draggingElement is selection element, which is never part of the elements array
          // local element is newer
          || localElement.version > remoteElement.version
          // resolve conflicting edits deterministically by taking the one with
          // the lowest versionNonce
          || (localElement.version === remoteElement.version
            && localElement.versionNonce < remoteElement.versionNonce))
	) {
		return true
	}

	// embeddables get updated a lot by the excalidraw library when collaboration is active
	// we need to filter out useless updates to not rerender every millisecond.
	// current master of the excalidraw library probably fixes this issue but it's not available in excalidraw@latest (0.17.6)
	if (localElement && localElement.type === 'embeddable' && isDeepEqual(localElement, remoteElement, ['versionNonce', 'version', 'updated', 'validated'])) {
		return true
	}
	return false
}

/**
 * Transforms array of objects containing `id` attribute,
 * or array of ids (strings), into a Map, keyd by `id`.
 * @param items array of objects which have the `id` attribute
 */
export function arrayToMap <T extends { id: string } | string>(items: readonly T[] | Map<string, T>) {
	if (items instanceof Map) {
		return items
	}
	return items.reduce((acc: Map<string, T>, element) => {
		acc.set(typeof element === 'string' ? element : element.id, element)
		return acc
	}, new Map())
}

/**
 * Decides which Elements are newer and should be displayed
 * @param localElements Elements stored locally
 * @param remoteElements Elements received from remote
 * @param appState state of the local app
 */
export function reconcileElements(localElements: readonly ExcalidrawElement[], remoteElements: ExcalidrawElement[], appState: Readonly<AppState>) {
	const added = new Set<string>()
	const localElementsMap = arrayToMap(localElements)
	const reconciledElements: ExcalidrawElement[] = []

	for (const remoteElement of remoteElements) {
		if (!added.has(remoteElement.id)) {
			const localElement = localElementsMap.get(remoteElement.id)
			const discardRemoteElement = shouldDiscardRemoteElement(
				appState,
				localElement,
				remoteElement,
			)

			if (localElement && discardRemoteElement) {
				reconciledElements.push(localElement)
				added.add(localElement.id)
			} else {
				reconciledElements.push(remoteElement)
				added.add(remoteElement.id)
			}
		}
	}
	for (const localElement of localElements) {
		if (!added.has(localElement.id)) {
			reconciledElements.push(localElement)
			added.add(localElement.id)
		}
	}

	return reconciledElements
}
