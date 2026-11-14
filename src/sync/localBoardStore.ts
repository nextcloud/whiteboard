/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles } from '@nextcloud/excalidraw/types'
import type { Table } from 'dexie'
import type { BoardSettings, ChangePart, Changes, Copies } from './changes.ts'

import * as Dexie from 'dexie'
import logger from '../utils/logger.ts'
import { changeSet, isEmpty, supersedes } from './changes.ts'
import { wins } from './elementOrder.ts'

/** An element, image or board setting Nextcloud does not have yet, kept until it does */
export interface OutboxEntry {
	account: string
	fileId: number
	epoch: string
	id: string
	element?: ExcalidrawElement
	file?: BinaryFileData
	settings?: BoardSettings
}

/** Unsaved changes kept after the board changed epoch (a restore, or a write by someone else) */
export interface RecoveryEntry {
	key?: number
	account: string
	fileId: number
	setAsideAt: number
	/** The epoch the changes were kept for, when known */
	epoch?: string
	elements: ExcalidrawElement[]
	files: BinaryFiles
	settings?: BoardSettings
}

/** The last scene of a board on this device, to open it while Nextcloud cannot be reached */
export interface SceneCache {
	account: string
	fileId: number
	elements: readonly ExcalidrawElement[]
	files: BinaryFiles
	appState?: Partial<AppState>
	cachedAt: number
	/** The board as Nextcloud had it then: its epoch and revision, the ids it had, its copies that differ from the scene's, its images and settings */
	server?: { epoch: string, rev: number, ids: string[], differing: ExcalidrawElement[], files: string[], settings?: BoardSettings }
}

/** Unsaved changes kept for recovery, with the keys to drop them once added back */
export type Recovered = Changes & { keys: number[] }

// Unsaved changes of an earlier epoch are kept this long for adding them back
const RECOVERY_DAYS = 30

const elementKey = (id: string) => `e:${id}`
const settingKey = (key: string) => `s:${key}`
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
	 * The changes this device keeps for one board of an account
	 *
	 * @param account
	 * @param fileId
	 */
	board(account: string, fileId: number): BoardStore {
		// Callers go on without the device when IndexedDB fails; the failure stays visible here
		const traced = <T>(what: string, result: Promise<T>): Promise<T> => result.catch((error) => {
			logger.warn(`[localBoardStore] Could not ${what}`, error)
			throw error
		})
		return {
			keep: (epoch, changes) => traced('keep unsaved changes', this.keep(account, fileId, epoch, changes)),
			dropSaved: (epoch, copies) => traced('drop saved changes', this.dropSaved(account, fileId, epoch, copies)),
			forgetSettings: (epoch, keys) => traced('drop settings changed back', this.forgetSettings(account, fileId, epoch, keys)),
			claimKept: (epoch) => traced('read kept changes', this.claimKept(account, fileId, epoch)),
			setAside: (current, extra) => traced('keep changes for recovery', this.setAside(account, fileId, current, extra)),
			recovered: () => traced('read changes kept for recovery', this.recovered(account, fileId)),
			dropRecovered: (keys) => traced('drop recovered changes', this.dropRecovered(keys)),
			cacheScene: (scene) => traced('keep the scene', this.cacheScene({ ...scene, account, fileId })),
			cachedScene: () => traced('read the scene', this.cachedScene(account, fileId)),
		}
	}

	/**
	 * Keeps unsaved changes of an epoch; a kept copy of an element is only
	 * replaced by one that wins over it
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param changes
	 */
	async keep(account: string, fileId: number, epoch: string, changes: Changes): Promise<void> {
		if (isEmpty(changes)) {
			return
		}
		await this.transaction('rw', this.outbox, () => this.keepIn(account, fileId, epoch, changes.elements, changes.files, changes.settings))
	}

	private async keepIn(account: string, fileId: number, epoch: string, elements: readonly ExcalidrawElement[], files: BinaryFiles, settings?: BoardSettings): Promise<void> {
		// One row per setting, so each one goes once Nextcloud has its value
		for (const [key, value] of Object.entries(settings ?? {})) {
			await this.outbox.put({ account, fileId, epoch, id: settingKey(key), settings: { [key]: value } })
		}
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
	 * Drops the kept changes of an epoch that `copies` Nextcloud has make unnecessary
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param copies
	 */
	async dropSaved(account: string, fileId: number, epoch: string, copies: Copies): Promise<void> {
		await this.drop(account, fileId, epoch, (part) => supersedes(copies, part))
	}

	/**
	 * Drops kept board settings of an epoch that were changed back to Nextcloud's value
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 * @param keys
	 */
	async forgetSettings(account: string, fileId: number, epoch: string, keys: string[]): Promise<void> {
		await this.drop(account, fileId, epoch, (part) => Boolean(part.settings) && Object.keys(part.settings as BoardSettings).every((key) => keys.includes(key)))
	}

	private async drop(account: string, fileId: number, epoch: string, dropped: (part: ChangePart) => boolean): Promise<void> {
		await this.transaction('rw', this.outbox, this.recovery, async () => {
			await this.outbox.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch && dropped(entry))
				.delete()
			// Another tab may have moved them to recovery meanwhile, for example at a restore
			const recovered = await this.recovery.where('[account+fileId]').equals([account, fileId]).filter((entry) => entry.epoch === epoch).toArray()
			for (const entry of recovered) {
				const elements = entry.elements.filter((element) => !dropped({ element }))
				const files = Object.fromEntries(Object.entries(entry.files).filter(([, file]) => !dropped({ file }))) as BinaryFiles
				const settings = Object.fromEntries(Object.entries(entry.settings ?? {}).filter(([key, value]) => !dropped({ settings: { [key]: value } }))) as BoardSettings
				if (isEmpty(changeSet(elements, files, settings))) {
					await this.recovery.delete(entry.key as number)
				} else if (elements.length !== entry.elements.length || Object.keys(files).length !== Object.keys(entry.files).length
					|| Object.keys(settings).length !== Object.keys(entry.settings ?? {}).length) {
					await this.recovery.put({ ...entry, elements, files, settings })
				}
			}
		})
	}

	/**
	 * The unsaved changes kept for an epoch, taking back those of the epoch
	 * that a tab still on an older one moved to recovery
	 *
	 * @param account
	 * @param fileId
	 * @param epoch
	 */
	async claimKept(account: string, fileId: number, epoch: string): Promise<Changes> {
		return this.transaction('rw', this.outbox, this.recovery, async () => {
			// Changes of this epoch that a tab still on an older one moved to recovery are unsaved changes again
			const reclaimed = await this.recovery.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch)
				.toArray()
			for (const entry of reclaimed) {
				await this.keepIn(account, fileId, epoch, entry.elements, entry.files, entry.settings)
			}
			await this.recovery.bulkDelete(reclaimed.map((entry) => entry.key as number))
			const entries = await this.outbox.where('[account+fileId]').equals([account, fileId])
				.filter((entry) => entry.epoch === epoch)
				.toArray()
			return toChanges(entries)
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
	 */
	async setAside(account: string, fileId: number, epoch: string | null, extra: Changes = changeSet()): Promise<boolean> {
		return this.transaction('rw', this.outbox, this.recovery, async () => {
			const others = (entry: OutboxEntry) => epoch !== null && entry.epoch !== epoch
			const stale = await this.outbox.where('[account+fileId]').equals([account, fileId]).filter(others).toArray()
			// One row per epoch, so changes of an epoch that turns out to be the current one can come back
			for (const fromEpoch of new Set(stale.map((entry) => entry.epoch))) {
				const { elements, files, settings } = toChanges(stale.filter((entry) => entry.epoch === fromEpoch))
				await this.recovery.add({ account, fileId, setAsideAt: Date.now(), epoch: fromEpoch, ...changeSet(elements, files, settings) })
			}
			if (!isEmpty(extra)) {
				await this.recovery.add({ account, fileId, setAsideAt: Date.now(), ...changeSet([...extra.elements], { ...extra.files }, { ...extra.settings }) })
			}
			await this.outbox.bulkDelete(stale.map((entry) => [entry.account, entry.fileId, entry.epoch, entry.id]))
			await this.dropExpired(account, fileId)
			return (await this.recovery.where('[account+fileId]').equals([account, fileId]).count()) > 0
		})
	}

	private async dropExpired(account: string, fileId: number): Promise<void> {
		const expired = Date.now() - RECOVERY_DAYS * 24 * 3600 * 1000
		await this.recovery.where('[account+fileId]').equals([account, fileId]).filter((entry) => entry.setAsideAt < expired).delete()
	}

	/**
	 * Whether this device keeps changes of the account that Nextcloud does
	 * not have, unsaved or set aside for recovery; a logout clears them
	 *
	 * @param account
	 */
	async keepsChanges(account: string): Promise<boolean> {
		const ofAccount = (entry: { account: string }) => entry.account === account
		return (await this.outbox.filter(ofAccount).count()) > 0 || (await this.recovery.filter(ofAccount).count()) > 0
	}

	/**
	 * The unsaved changes kept in the recovery store
	 *
	 * @param account
	 * @param fileId
	 */
	async recovered(account: string, fileId: number): Promise<Recovered> {
		return this.transaction('rw', this.recovery, async () => {
			await this.dropExpired(account, fileId)
			const entries = (await this.recovery.where('[account+fileId]').equals([account, fileId]).toArray()).sort((a, b) => a.setAsideAt - b.setAsideAt)
			const byId = new Map<string, ExcalidrawElement>()
			const files: BinaryFiles = {}
			let settings: BoardSettings | undefined
			for (const entry of entries) {
				if (entry.settings) {
					// The later choice of each setting
					settings = { ...settings, ...entry.settings }
				}
				for (const element of entry.elements) {
					const current = byId.get(element.id)
					if (!current || wins(element, current)) {
						byId.set(element.id, element)
					}
				}
				Object.assign(files, entry.files)
			}
			return { keys: entries.map((entry) => entry.key as number), ...changeSet([...byId.values()], files, settings) }
		})
	}

	async dropRecovered(keys: number[]): Promise<void> {
		await this.recovery.bulkDelete(keys)
	}

	async cacheScene(scene: SceneCache): Promise<void> {
		await this.scenes.put(scene)
	}

	async cachedScene(account: string, fileId: number): Promise<SceneCache | undefined> {
		return this.scenes.get([account, fileId])
	}
}

function toChanges(entries: OutboxEntry[]): Changes {
	const elements: ExcalidrawElement[] = []
	const files: BinaryFiles = {}
	let settings: BoardSettings | undefined
	for (const entry of entries) {
		if (entry.element) {
			elements.push(entry.element)
		}
		if (entry.file) {
			files[entry.file.id] = entry.file
		}
		if (entry.settings) {
			settings = { ...settings, ...entry.settings }
		}
	}
	return changeSet(elements, files, settings)
}

/** The changes this device keeps for one board of an account; every call is one IndexedDB transaction, run in the order of the calls */
export interface BoardStore {
	keep(epoch: string, changes: Changes): Promise<void>
	dropSaved(epoch: string, copies: Copies): Promise<void>
	forgetSettings(epoch: string, keys: string[]): Promise<void>
	claimKept(epoch: string): Promise<Changes>
	/** Moves the unsaved changes of other epochs than `current` (none when it is null), and `extra`, to the recovery store; returns whether there is something to recover */
	setAside(current: string | null, extra?: Changes): Promise<boolean>
	recovered(): Promise<Recovered>
	dropRecovered(keys: number[]): Promise<void>
	cacheScene(scene: Omit<SceneCache, 'account' | 'fileId'>): Promise<void>
	cachedScene(): Promise<SceneCache | undefined>
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
