/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'

import { bumpVersion, newElementWith, restoreElements } from '@nextcloud/excalidraw'

/**
 * The elements of a version as a new edit of the current board: each element
 * that differs from its current copies gets a version above all of them, and
 * the elements added after the version are deleted, so that the restore wins
 * over the copies other sessions still hold.
 *
 * @param versionElements elements stored in the version
 * @param currentElements copies of the board's elements known now, as stored, including deleted ones; an id may appear more than once
 */
export function restoreVersionElements(versionElements: readonly ExcalidrawElement[], currentElements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
	const copiesById = new Map<string, ExcalidrawElement[]>()
	currentElements.forEach((element) => {
		copiesById.set(element.id, [...(copiesById.get(element.id) ?? []), element])
	})
	const latestCopy = (copies: ExcalidrawElement[]) => copies.reduce((latest, copy) => (copy.version > latest.version ? copy : latest))

	const restoredElements = (restoreElements(versionElements, null) as ExcalidrawElement[]).map((element) => {
		const copies = copiesById.get(element.id) ?? []
		const isCurrent = copies.every((copy) => copy.version === element.version && copy.versionNonce === element.versionNonce && Boolean(copy.isDeleted) === Boolean(element.isDeleted))
		return isCurrent ? element : bumpVersion(element, Math.max(element.version, latestCopy(copies).version))
	})
	const restoredIds = new Set(restoredElements.map((element) => element.id))
	const removedElements = [...copiesById.entries()]
		.filter(([id]) => !restoredIds.has(id))
		.map(([, copies]) => newElementWith(latestCopy(copies), { isDeleted: true }, true))

	return [...restoredElements, ...removedElements]
}
