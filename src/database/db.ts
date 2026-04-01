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
	appState?: Partial<AppState>
	scrollToContent?: boolean
	savedAt?: number
	hasPendingLocalChanges?: boolean
	lastSyncedHash?: number
	persistedRev?: number
	lastServerUpdatedAt?: number | null
	lastServerUpdatedBy?: string | null
}

export class WhiteboardDatabase extends Dexie.Dexie {

	whiteboards!: Table<WhiteboardData>

	constructor() {
		super('WhiteboardDatabase')

		this.version(1).stores({
			whiteboards: '++id, savedAt',
		})

		this.version(2).stores({
			whiteboards: '++id, savedAt',
		}).upgrade(async (tx) => {
			await tx.table('whiteboards').toCollection().modify((whiteboard: WhiteboardData) => {
				whiteboard.persistedRev = whiteboard.persistedRev ?? 0
				whiteboard.lastServerUpdatedAt = whiteboard.lastServerUpdatedAt ?? null
				whiteboard.lastServerUpdatedBy = whiteboard.lastServerUpdatedBy ?? null
				whiteboard.scrollToContent = whiteboard.scrollToContent ?? true
			})
		})
	}

	async get(
		fileId: number,
	): Promise<WhiteboardData | undefined> {
		const whiteboard = await this.whiteboards.get(fileId)
		if (!whiteboard) {
			return undefined
		}

		return {
			...whiteboard,
			persistedRev: whiteboard.persistedRev ?? 0,
			lastServerUpdatedAt: whiteboard.lastServerUpdatedAt ?? null,
			lastServerUpdatedBy: whiteboard.lastServerUpdatedBy ?? null,
			scrollToContent: whiteboard.scrollToContent ?? true,
		}
	}

	async put(
		fileId: number,
		elements: ExcalidrawElement[],
		files: BinaryFiles,
		appState?: Partial<AppState>,
		options: {
			scrollToContent?: boolean
			hasPendingLocalChanges?: boolean
			lastSyncedHash?: number
			persistedRev?: number
			lastServerUpdatedAt?: number | null
			lastServerUpdatedBy?: string | null
		} = {},
	): Promise<number> {
		const existing = await this.whiteboards.get(fileId)

		const data = {
			id: fileId,
			elements,
			files,
			appState,
			scrollToContent: options.scrollToContent ?? existing?.scrollToContent ?? true,
			savedAt: Date.now(),
			hasPendingLocalChanges: options.hasPendingLocalChanges ?? existing?.hasPendingLocalChanges ?? false,
			lastSyncedHash: options.lastSyncedHash ?? existing?.lastSyncedHash,
			persistedRev: options.persistedRev ?? existing?.persistedRev ?? 0,
			lastServerUpdatedAt: options.lastServerUpdatedAt ?? existing?.lastServerUpdatedAt ?? null,
			lastServerUpdatedBy: options.lastServerUpdatedBy ?? existing?.lastServerUpdatedBy ?? null,
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
