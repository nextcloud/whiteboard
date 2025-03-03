/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types'

export interface WhiteboardData {
	id: number
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState?: AppState
	savedAt?: number
}

export class WhiteboardDatabase extends Dexie.Dexie {

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
		appState?: AppState,
	): Promise<number> {
		const data = {
			id: fileId,
			elements,
			files,
			appState,
			savedAt: Date.now(),
		}

		return this.whiteboards.put(data)
	}

	async delete(fileId: number): Promise<void> {
		return this.whiteboards.delete(fileId)
	}

	async clear(): Promise<void> {
		return this.whiteboards.clear()
	}

}

export const db = new WhiteboardDatabase()
