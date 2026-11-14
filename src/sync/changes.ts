/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles } from '@nextcloud/excalidraw/types'

import { isEqual } from 'lodash'
import { wins } from './elementOrder.ts'

/** Settings of the whole board, which every tab shows the same; Nextcloud keeps the last one saved */
export const BOARD_SETTINGS = ['viewBackgroundColor', 'gridSize', 'gridStep'] as const
export type BoardSettings = Partial<Pick<AppState, typeof BOARD_SETTINGS[number]>>

/** Elements, images and board settings of a board, for example those Nextcloud does not have yet */
export type Changes = { elements: ExcalidrawElement[], files: BinaryFiles, settings?: BoardSettings }

/** One element, image or setting of a change set */
export type ChangePart = { element?: ExcalidrawElement, file?: BinaryFileData, settings?: BoardSettings }

/** Copies of a board that kept changes are checked against */
export type Copies = {
	elements: ReadonlyMap<string, ExcalidrawElement>
	files: { has: (id: string) => boolean }
	settings: BoardSettings
}

/**
 * A change set; settings only when there are any
 *
 * @param elements
 * @param files
 * @param settings
 */
export function changeSet(elements: ExcalidrawElement[] = [], files: BinaryFiles = {}, settings: BoardSettings = {}): Changes {
	return { elements, files, ...(Object.keys(settings).length > 0 ? { settings } : {}) }
}

/**
 * @param changes
 */
export function isEmpty(changes: Changes): boolean {
	return changes.elements.length === 0 && Object.keys(changes.files).length === 0 && Object.keys(changes.settings ?? {}).length === 0
}

/**
 * The copies a change set carries
 *
 * @param changes
 */
export function copiesOf(changes: Changes): Copies {
	return {
		elements: new Map(changes.elements.map((element) => [element.id, element])),
		files: { has: (id) => Boolean(changes.files[id]) },
		settings: changes.settings ?? {},
	}
}

/**
 * Whether a kept element, image or setting is no longer needed next to
 * `copies`: an element when its copy there does not lose to the kept one,
 * an image when its id is there, a setting when its value is the same
 *
 * @param copies
 * @param part
 */
export function supersedes(copies: Copies, part: ChangePart): boolean {
	if (part.element) {
		const copy = copies.elements.get(part.element.id)
		return Boolean(copy) && !wins(part.element, copy as ExcalidrawElement)
	}
	if (part.settings) {
		return Object.entries(part.settings).every(([key, value]) => isEqual(value, copies.settings[key as keyof BoardSettings]))
	}
	return Boolean(part.file && copies.files.has(part.file.id))
}
