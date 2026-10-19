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
	hasPendingLocalChanges?: boolean
	lastSyncedHash?: number
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
		options: {
			hasPendingLocalChanges?: boolean
			lastSyncedHash?: number
		} = {},
	): Promise<number> {
		const existing = await this.whiteboards.get(fileId)

		const data = {
			id: fileId,
			elements,
			files,
			appState,
			savedAt: Date.now(),
			hasPendingLocalChanges: options.hasPendingLocalChanges ?? existing?.hasPendingLocalChanges ?? false,
			lastSyncedHash: options.lastSyncedHash ?? existing?.lastSyncedHash,
		}

		return this.whiteboards.put(data)
	}

	// After an upload of the board. One transaction, so a draft another tab writes
	// meanwhile cannot be overwritten between the check and the write.
	async markSaved(
		fileId: number,
		elements: ExcalidrawElement[],
		files: BinaryFiles,
		lastSyncedHash: number,
		isUploadedScene: (stored: WhiteboardData) => boolean,
	): Promise<void> {
		await this.transaction('rw', this.whiteboards, async () => {
			const existing = await this.whiteboards.get(fileId)
			if (existing && isUploadedScene(existing)) {
				await this.whiteboards.update(fileId, { hasPendingLocalChanges: false, lastSyncedHash })
				return
			}
			if (existing?.hasPendingLocalChanges) {
				return
			}
			await this.whiteboards.put({
				id: fileId,
				elements,
				files,
				appState: existing?.appState,
				savedAt: Date.now(),
				hasPendingLocalChanges: false,
				lastSyncedHash,
			})
		})
	}

	async delete(fileId: number): Promise<void> {
		return this.whiteboards.delete(fileId)
	}

	async clear(): Promise<void> {
		return this.whiteboards.clear()
	}

}

export const db = new WhiteboardDatabase()
