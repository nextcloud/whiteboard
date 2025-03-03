/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'

export interface WhiteboardData {
	id: number
	elements: ExcalidrawElement[]
	files: BinaryFiles
}

export class WhiteboardDatabase extends Dexie {

	whiteboards!: Table<WhiteboardData>

	constructor() {
		super('WhiteboardDatabase')

		this.version(1).stores({
			whiteboards: '++id, savedAt',
		})
	}

	async get(
		fileId: number,
	): Promise<WhiteboardData | undefined> {
		return this.whiteboards.get(fileId)
	}

	async put(
		fileId: number,
		elements: ExcalidrawElement[],
		files: BinaryFiles,
	): Promise<number> {
		const data = {
			id: fileId,
			elements,
			files,
		}

		return this.whiteboards.put(data)
	}

}

export const db = new WhiteboardDatabase()
