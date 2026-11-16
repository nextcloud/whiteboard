/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'

/**
 * Hashes elements' version and isDeleted status (using djb2 algo principle). Order of elements matters.
 * @param elements all Elements, potentially including deleted ones
 */
export const computeElementVersionHash = (
	elements: readonly ExcalidrawElement[],
): number => {
	let hash = 5381 // djb2 starting point

	// Special case: empty elements array should have a unique hash
	// This ensures that when all elements are deleted, the hash changes
	if (elements.length === 0) {
		return 1 // Special hash for empty array
	}

	// Count deleted elements to ensure hash changes when elements are deleted
	let deletedCount = 0

	for (const el of elements) {
		// Combine version, nonce, and deletion status into the hash
		// Using prime numbers helps distribute values
		hash = (hash * 33) ^ (el.version || 0)
		hash = (hash * 33) ^ (el.versionNonce || 0)

		// Track deletion status
		if (el.isDeleted) {
			deletedCount++
			hash = (hash * 33) ^ 1 // Include isDeleted status
		}
	}

	// Include deleted count in the hash to ensure it changes when elements are deleted
	hash = (hash * 33) ^ deletedCount

	return hash >>> 0 // Ensure positive integer
}

export type BroadcastedElementVersion = {
	version: number
	versionNonce: number
}

export type BroadcastedElementVersions = Record<string, BroadcastedElementVersion>

const buildElementVersionMarker = (
	element: Pick<ExcalidrawElement, 'version' | 'versionNonce'>,
): BroadcastedElementVersion => ({
	version: element.version,
	versionNonce: element.versionNonce,
})

export const buildBroadcastedElementVersions = (
	elements: readonly ExcalidrawElement[],
): BroadcastedElementVersions => {
	return elements.reduce<BroadcastedElementVersions>((versions, element) => {
		versions[element.id] = buildElementVersionMarker(element)
		return versions
	}, {})
}

export const updateBroadcastedElementVersions = (
	currentVersions: BroadcastedElementVersions,
	elements: readonly ExcalidrawElement[],
): BroadcastedElementVersions => {
	if (elements.length === 0) {
		return currentVersions
	}

	const nextVersions = { ...currentVersions }

	elements.forEach((element) => {
		nextVersions[element.id] = buildElementVersionMarker(element)
	})

	return nextVersions
}

export const getIncrementalSceneElements = (
	elements: readonly ExcalidrawElement[],
	broadcastedElementVersions: BroadcastedElementVersions,
): readonly ExcalidrawElement[] => {
	return elements.filter((element) => {
		const currentVersion = broadcastedElementVersions[element.id]
		return currentVersion?.version !== element.version
			|| currentVersion.versionNonce !== element.versionNonce
	})
}
