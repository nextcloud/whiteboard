/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { AppState } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import { isObject } from 'lodash'

/**
 * Hashes elements' version and isDeleted status (using djb2 algo principle). Order of elements matters.
 * @param elements all Elements, potentially including deleted ones
 */
export const computeElementVersionHash = (
	elements: readonly ExcalidrawElement[],
): number => {
	// Keep this hash worker-safe: importing the full excalidraw runtime pulls in
	// browser-only globals such as `window`, which breaks the sync worker.
	let hash = 5381
	for (let i = 0; i < elements.length; i++) {
		hash = (hash << 5) + hash + elements[i].versionNonce
	}
	return hash >>> 0
}

export const buildBroadcastedElementVersions = (
	elements: readonly ExcalidrawElement[],
): Record<string, number> => {
	return elements.reduce<Record<string, number>>((versions, element) => {
		versions[element.id] = element.version
		return versions
	}, {})
}

export const mergeBroadcastedElementVersions = (
	currentVersions: Record<string, number>,
	elements: readonly ExcalidrawElement[],
): Record<string, number> => {
	const nextVersions = { ...currentVersions }

	elements.forEach((element) => {
		const currentVersion = nextVersions[element.id]
		nextVersions[element.id] = currentVersion === undefined
			? element.version
			: Math.max(currentVersion, element.version)
	})

	return nextVersions
}

export const getIncrementalSceneElements = (
	elements: readonly ExcalidrawElement[],
	broadcastedElementVersions: Record<string, number>,
): readonly ExcalidrawElement[] => {
	return elements.filter((element) => broadcastedElementVersions[element.id] !== element.version)
}

type SceneSyncPlanNoop = {
	type: 'noop'
}

type SceneSyncPlanAdvance = {
	type: 'advance'
	sceneHash: number
	broadcastedElementVersions: Record<string, number>
}

type SceneSyncPlanBroadcast = {
	type: 'broadcast'
	sceneHash: number
	sceneElements: readonly ExcalidrawElement[]
	broadcastedElementVersions: Record<string, number>
}

export type IncrementalSceneSyncPlan = SceneSyncPlanNoop | SceneSyncPlanAdvance | SceneSyncPlanBroadcast

export const planIncrementalSceneSync = ({
	elements,
	broadcastedElementVersions,
	lastSceneHash,
}: {
	elements: readonly ExcalidrawElement[]
	broadcastedElementVersions: Record<string, number>
	lastSceneHash: number | null
}): IncrementalSceneSyncPlan => {
	const sceneHash = computeElementVersionHash(elements)

	if (lastSceneHash === sceneHash) {
		return { type: 'noop' }
	}

	const incrementalElements = getIncrementalSceneElements(elements, broadcastedElementVersions)

	if (incrementalElements.length === 0) {
		return {
			type: 'advance',
			sceneHash,
			broadcastedElementVersions: buildBroadcastedElementVersions(elements),
		}
	}

	return {
		type: 'broadcast',
		sceneHash,
		sceneElements: incrementalElements,
		broadcastedElementVersions: buildBroadcastedElementVersions(incrementalElements),
	}
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
function shouldDiscardRemoteElement(localAppState: Readonly<AppState>, localElement: ExcalidrawElement | undefined, remoteElement: ExcalidrawElement) {
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
function arrayToMap <T extends { id: string } | string>(items: readonly T[] | Map<string, T>) {
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
export function mergeSceneElements(localElements: readonly ExcalidrawElement[], remoteElements: ExcalidrawElement[], appState: Readonly<AppState>) {
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
