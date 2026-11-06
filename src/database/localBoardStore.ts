/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles } from '@nextcloud/excalidraw/types'
import type { Table } from 'dexie'

import * as Dexie from 'dexie'
import { wins } from '../utils/elementOrder.ts'

/** An element or image the server does not have yet, kept until it does */
export interface OutboxEntry {
	account: string
	fileId: number
	epoch: string
	id: string
	element?: ExcalidrawElement
	file?: BinaryFileData
}

/** Unsaved changes kept after the board changed epoch (a restore, or a write by someone else) */
export interface RecoveryEntry {
	key?: number
	account: string
	fileId: number
	savedAt: number
	/** The epoch the changes were kept for, when known */
	epoch?: string
	elements: ExcalidrawElement[]
	files: BinaryFiles
}

/** The last scene of a board on this device, to open it while Nextcloud cannot be reached */
export interface SceneCache {
	account: string
	fileId: number
	elements: readonly ExcalidrawElement[]
	files: BinaryFiles
	appState?: Partial<AppState>
	savedAt: number
	/** The board as Nextcloud had it then: its epoch and revision, the ids it had, its copies that differ from the scene's, and its images */
	server?: { epoch: string, rev: number, ids: string[], differing: ExcalidrawElement[], files: string[] }
}

/** Unsaved changes kept for recovery, with the keys to drop them once added back */
export type Recovered = { keys: number[], elements: ExcalidrawElement[], files: BinaryFiles }

const elementKey = (id: string) => `e:${id}`
const fileKey = (id: string) => `f:${id}`

class LocalBoardStore extends Dexie.Dexie {
	outbox!: Table<OutboxEntry, [string, number, string, string]>
	recovery!: Table<RecoveryEntry, number>
	scenes!: Table<SceneCache, [string, number]>

	constructor() {
		super('WhiteboardSync')
		this.version(1).stores({
			outbox: '[account+fileId+epoch+id], [account+fileId]',
			recovery: '++key, [account+fileId]',
			scenes: '[account+fileId]',
		})
	}

	/**
	 * Keeps unsaved elements and images of an epoch; a stored copy is only
	 * replaced by one that wins over it
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param elements
	 * @param files
	 */
	async keep(account: string, fileId: number, epoch: string, elements: readonly ExcalidrawElement[], files: BinaryFiles): Promise<void> {
		if (elements.length === 0 && Object.keys(files).length === 0) {
			return
		}
		await this.transaction('rw', this.outbox, () => this.keepIn(account, fileId, epoch, elements, files))
	}

	private async keepIn(account: string, fileId: number, epoch: string, elements: readonly ExcalidrawElement[], files: BinaryFiles): Promise<void> {
		for (const element of elements) {
			const key: [string, number, string, string] = [account, fileId, epoch, elementKey(element.id)]
			const kept = await this.outbox.get(key)
			if (!kept?.element || wins(element, kept.element)) {
				await this.outbox.put({ account, fileId, epoch, id: elementKey(element.id), element })
			}
		}
		for (const file of Object.values(files)) {
			await this.outbox.put({ account, fileId, epoch, id: fileKey(file.id), file })
		}
	}

	/**
	 * Drops what the server has: an element when the server's copy is not
	 * older, an image when the server has its id
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param serverHas
	 */
	async prune(account: string, fileId: number, epoch: string, serverHas: (entry: OutboxEntry) => boolean): Promise<void> {
		await this.transaction('rw', this.outbox, async () => {
			await this.outbox.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch && serverHas(entry))
				.delete()
		})
	}

	/**
	 * The unsaved elements and images kept for an epoch
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 */
	async kept(account: string, fileId: number, epoch: string): Promise<{ elements: ExcalidrawElement[], files: BinaryFiles }> {
		return this.transaction('rw', this.outbox, this.recovery, async () => {
			// Changes of this epoch that a tab still on an older one moved to recovery are unsaved changes again
			const reclaimed = await this.recovery.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch)
				.toArray()
			for (const entry of reclaimed) {
				await this.keepIn(account, fileId, epoch, entry.elements, entry.files)
			}
			await this.recovery.bulkDelete(reclaimed.map((entry) => entry.key as number))
			const entries = await this.outbox.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch)
				.toArray()
			return toScene(entries)
		})
	}

	/**
	 * Moves the unsaved changes of other epochs than `epoch` (none when it is
	 * null), and `extra`, to the recovery store; returns whether there is
	 * something to recover
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param extra
	 * @param extra.elements
	 * @param extra.files
	 */
	async recover(account: string, fileId: number, epoch: string | null, extra: { elements: readonly ExcalidrawElement[], files: BinaryFiles } = { elements: [], files: {} }): Promise<boolean> {
		return this.transaction('rw', this.outbox, this.recovery, async () => {
			const others = (entry: OutboxEntry) => epoch !== null && entry.epoch !== epoch
			const stale = await this.outbox.where('[account+fileId]').equals([account, fileId]).filter(others).toArray()
			// One row per epoch, so changes of an epoch that turns out to be the current one can come back
			for (const fromEpoch of new Set(stale.map((entry) => entry.epoch))) {
				const { elements, files } = toScene(stale.filter((entry) => entry.epoch === fromEpoch))
				await this.recovery.add({ account, fileId, savedAt: Date.now(), epoch: fromEpoch, elements, files })
			}
			if (extra.elements.length > 0 || Object.keys(extra.files).length > 0) {
				await this.recovery.add({ account, fileId, savedAt: Date.now(), elements: [...extra.elements], files: { ...extra.files } })
			}
			await this.outbox.bulkDelete(stale.map((entry) => [entry.account, entry.fileId, entry.epoch, entry.id]))
			return (await this.recovery.where('[account+fileId]').equals([account, fileId]).count()) > 0
		})
	}

	/**
	 * The unsaved changes kept in the recovery store
	 *
	 * @param account
	 * @param fileId
	 */
	async recovered(account: string, fileId: number): Promise<Recovered> {
		return this.transaction('r', this.recovery, async () => {
			const entries = await this.recovery.where('[account+fileId]').equals([account, fileId]).toArray()
			const byId = new Map<string, ExcalidrawElement>()
			const files: BinaryFiles = {}
			for (const entry of entries) {
				for (const element of entry.elements) {
					const current = byId.get(element.id)
					if (!current || wins(element, current)) {
						byId.set(element.id, element)
					}
				}
				Object.assign(files, entry.files)
			}
			return { keys: entries.map((entry) => entry.key as number), elements: [...byId.values()], files }
		})
	}

	async dropRecovered(keys: number[]): Promise<void> {
		await this.recovery.bulkDelete(keys)
	}

	async saveScene(scene: SceneCache): Promise<void> {
		await this.scenes.put(scene)
	}

	async loadScene(account: string, fileId: number): Promise<SceneCache | undefined> {
		return this.scenes.get([account, fileId])
	}
}

function toScene(entries: OutboxEntry[]): { elements: ExcalidrawElement[], files: BinaryFiles } {
	const elements: ExcalidrawElement[] = []
	const files: BinaryFiles = {}
	for (const entry of entries) {
		if (entry.element) {
			elements.push(entry.element)
		}
		if (entry.file) {
			files[entry.file.id] = entry.file
		}
	}
	return { elements, files }
}

export const localBoardStore = new LocalBoardStore()

/**
 * The unsaved draft that a client older than this engine kept for the
 * board. It carries no epoch, so it cannot be merged safely: the board may
 * have been restored since it was written.
 *
 * @param fileId
 */
export async function legacyDraft(fileId: number): Promise<{ elements: ExcalidrawElement[], files: BinaryFiles } | null> {
	const record = await legacyRecord((store) => store.get(fileId)).catch(() => null) as { hasPendingLocalChanges?: boolean, elements?: ExcalidrawElement[], files?: BinaryFiles } | null
	return record?.hasPendingLocalChanges && Array.isArray(record.elements) && record.elements.length > 0
		? { elements: record.elements, files: record.files ?? {} }
		: null
}

/**
 * Drops the previous client's copy of the board
 *
 * @param fileId
 */
export async function dropLegacyDraft(fileId: number): Promise<void> {
	await legacyRecord((store) => store.delete(fileId)).catch(() => null)
}

async function legacyRecord(operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
	if (typeof indexedDB === 'undefined' || !(await indexedDB.databases?.())?.some((db) => db.name === 'WhiteboardDatabase')) {
		return null
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('WhiteboardDatabase')
		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			const db = request.result
			if (!db.objectStoreNames.contains('whiteboards')) {
				db.close()
				resolve(null)
				return
			}
			const transaction = db.transaction('whiteboards', 'readwrite')
			const result = operation(transaction.objectStore('whiteboards'))
			transaction.oncomplete = () => {
				db.close()
				resolve(result.result)
			}
			transaction.onerror = () => {
				db.close()
				reject(transaction.error)
			}
		}
	})
}
