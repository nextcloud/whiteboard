/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'
import type { localBoardStore, SceneCache } from '../database/localBoardStore.ts'

import { CaptureUpdateAction, restoreElements } from '@nextcloud/excalidraw'
import { isEqual } from 'lodash'
import { inIndexOrder, sameStamp, wins } from '../utils/elementOrder.ts'
import { mergeElementsWithMetadata } from '../utils/mergeElementsWithMetadata.ts'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState.ts'
import { SCENE_SCHEMA_VERSION } from '../utils/sceneSchema.ts'

export type BoardSyncState = { epoch: string, rev: number }

export type BoardContent = {
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState?: Partial<AppState>
	scrollToContent?: boolean
	[key: string]: unknown
}

type Changes = { elements: ExcalidrawElement[], files: BinaryFiles }
type ServerAnswer = { sync: BoardSyncState, delta?: Changes, data?: BoardContent, code?: string }
export type BoardRequest = (method: 'GET' | 'PUT' | 'POST', options?: {
	path?: string
	query?: Record<string, string>
	body?: unknown
	keepalive?: boolean
}) => Promise<{ status: number, body: ServerAnswer | null }>

export interface BoardSyncOptions {
	fileId: number
	/** The account or public share the board is open with */
	account: string
	request: BoardRequest
	editor: () => ExcalidrawImperativeAPI | null
	isReadOnly: () => boolean
	/** The collaboration server picked this tab to save first for the room */
	isLeader: () => boolean
	isInRoom: () => boolean
	/** Tells the room that the board has a new revision, so others fetch it */
	announce: (type: 'saved' | 'restored', sync: BoardSyncState) => void
	/** This device keeps unsaved changes of the board from before its epoch changed (`opened`: found when the board opened) */
	onRecoverable: (opened: boolean) => void
	store: Pick<typeof localBoardStore, 'keep' | 'prune' | 'kept' | 'recover' | 'saveScene' | 'loadScene'>
	/** Ends a text edit in progress, as leaving the text field does */
	endEditing?: () => void
	/** The unsaved draft of the previous client, and how to drop it once it is in the recovery store */
	legacyDraft?: { read: () => Promise<Changes | null>, drop: () => Promise<void> }
	now?: () => number
}

// The tab the collaboration server picked saves the room's changes this often
const LEADER_SAVE_INTERVAL = 10_000
// Other tabs save what is still unsaved after this long, in case that tab cannot
const FALLBACK_SAVE_AFTER = 30_000
const POLL_IN_ROOM = 60_000
const POLL_ALONE = 15_000
// A read-only tab shows an element it got from a writer this long without
// Nextcloud having it, then shows the stored copy (the writer left before saving)
const READ_ONLY_GRACE = 120_000
const KEEP_DELAY = 300
const SCENE_CACHE_INTERVAL = 10_000
// Browsers refuse keepalive requests above 64 KiB
const KEEPALIVE_LIMIT = 60 * 1024
const MAX_RETRY_DELAY = 60_000
// A request that never ends would hold back every later fetch and save
const REQUEST_TIMEOUT = 60_000

/**
 * Keeps one board in sync with Nextcloud.
 *
 * The tab holds a copy of the board as Nextcloud has it (the replica). What
 * wins over the replica is unsaved: it is kept in IndexedDB and sent until
 * Nextcloud has it. Nextcloud merges every save into the stored board and
 * answers with all changes since the tab's revision, which the scene takes
 * once you are not editing those elements. When the board starts a new epoch
 * (a restore, or a write by someone else), the tab loads the new board and
 * keeps its unsaved changes in a recovery store.
 */
export class BoardSync {
	epoch: string | null = null
	rev = 0

	private replica = new Map<string, ExcalidrawElement>()
	private serverFiles = new Set<string>()
	private unsavedSince = new Map<string, number>()
	private aheadSince = new Map<string, number>()
	// Server copies not shown yet because you were editing them
	private deferred = new Set<string>()
	// Opened from this device's copy: Nextcloud has not answered yet
	private provisional = false
	// Counts the boards loaded, so an answer about an earlier one is not applied
	private loads = 0
	// A board loaded before the editor showed anything; the editor shows it as soon as it is there
	private unshown: BoardContent | null = null
	// The last board that replaced the scene, for an open that it overtook
	private lastBoard: BoardContent | null = null
	// Images that arrived before the editor was there
	private unshownFiles: BinaryFiles = {}
	// This tab could save at some point; being read-only for a while (a token refresh) does not make it a viewer
	private wasWritable = false
	// Unsaved changes of earlier epochs that IndexedDB did not take yet
	private pendingRecovery: Changes[] = []
	private recoveryRetry: ReturnType<typeof setTimeout> | undefined
	private saving: Promise<void> | null = null
	private saveAgain = false
	private fetching: Promise<void> | null = null
	private fetchAgain = false
	private reloading: Promise<void> | null = null
	private repairing = false
	private lastSave = 0
	private lastSceneCache = 0
	private retryDelay = 0
	private saveDue = Infinity
	// The scene at the last change, for when the board closes after the editor is gone
	private lastScene: { elements: readonly ExcalidrawElement[], files: BinaryFiles } | null = null
	private closed = false
	private timers: Partial<Record<'keep' | 'save' | 'poll' | 'retry' | 'hint' | 'grace' | 'cache', ReturnType<typeof setTimeout>>> = {}

	constructor(private options: BoardSyncOptions) {
	}

	get fileId(): number {
		return this.options.fileId
	}

	/**
	 * Loads the board and returns the scene to show: the stored board and the
	 * unsaved changes this device kept for its epoch. When Nextcloud cannot
	 * be reached, the last scene on this device, kept in sync once it can.
	 */
	async open(): Promise<BoardContent | null> {
		const { fileId, account, store } = this.options
		const response = await this.send('GET').catch(() => null)
		const cached = await store.loadScene(account, fileId).catch(() => undefined)
		if (this.closed) {
			return null
		}
		if (response?.status === 409 && response.body?.code === 'board_unreadable') {
			this.adopt(response.body.sync, { elements: [], files: {} })
			this.repairing = true
			this.schedulePoll()
			return cached ? { elements: [...cached.elements], files: cached.files, appState: cached.appState } : null
		}
		if (response?.status !== 200 || !response.body?.data) {
			return this.openFromDevice(cached)
		}

		const data = response.body.data
		this.adopt(response.body.sync, data)
		this.viewerOnly()
		const opened = this.loads
		const kept = await store.kept(account, fileId, this.epoch as string).catch(() => ({ elements: [], files: {} }))
		const legacy = await this.options.legacyDraft?.read().catch(() => null) ?? undefined
		const recoverable = await store.recover(account, fileId, this.epoch as string, legacy).catch(() => null)
		if (recoverable) {
			this.options.onRecoverable(true)
		}
		if (legacy && recoverable !== null) {
			await this.options.legacyDraft?.drop().catch(() => {})
		}
		this.schedulePoll()
		if (this.loads !== opened && this.lastBoard) {
			// Another board replaced this one while it opened
			return this.overtaken()
		}

		return {
			...data,
			// The replica also has what arrived while the board opened
			elements: withKept([...this.replica.values()], kept.elements),
			files: { ...kept.files, ...data.files, ...this.unshownFiles },
			// Settings changed on this device stay, unless the board sets them
			appState: { ...cached?.appState, ...data.appState },
		}
	}

	/**
	 * Works on the board as this device last had it from Nextcloud until
	 * Nextcloud answers. Without such a copy the epoch is unknown, so the
	 * first answer loads the board and the changes made meanwhile go to the
	 * recovery store.
	 *
	 * @param cached
	 */
	private async openFromDevice(cached: SceneCache | undefined): Promise<BoardContent | null> {
		const server = cached?.server
		this.provisional = true
		this.epoch = server?.epoch ?? ''
		this.rev = server?.rev ?? 0
		const shown = new Map((cached?.elements ?? []).map((element) => [element.id, element]))
		this.replica = new Map((server?.ids ?? []).flatMap((id) => shown.has(id) ? [[id, shown.get(id) as ExcalidrawElement]] : []))
		server?.differing.forEach((element) => {
			this.replica.set(element.id, element)
			const mine = shown.get(element.id)
			if (mine && sameStamp(mine, element)) {
				this.deferred.add(element.id)
			}
		})
		this.serverFiles = new Set(server?.files ?? [])
		this.schedulePoll()
		if (!cached) {
			return null
		}
		const opened = this.loads
		const kept = await this.options.store.kept(this.options.account, this.options.fileId, this.epoch).catch(() => ({ elements: [], files: {} }))
		if (this.loads !== opened && this.lastBoard) {
			// Nextcloud answered with another board while this one opened
			return this.overtaken()
		}
		return {
			elements: withKept(cached.elements, kept.elements),
			files: { ...cached.files, ...kept.files },
			appState: cached.appState,
		}
	}

	/**
	 * The board that replaced the one being opened, with what this device kept
	 * unsaved for its epoch; the open shows it, so it is not shown again
	 */
	private async overtaken(): Promise<BoardContent> {
		for (;;) {
			const loads = this.loads
			const board = this.lastBoard as BoardContent
			const kept = await this.options.store.kept(this.options.account, this.options.fileId, this.epoch as string).catch(() => ({ elements: [], files: {} }))
			// Unless yet another board came meanwhile
			if (loads === this.loads) {
				this.unshown = null
				return { ...board, elements: withKept(board.elements, kept.elements), files: { ...board.files, ...this.unshownFiles, ...kept.files } }
			}
		}
	}

	/** Call on every change of the scene */
	changed(): void {
		// Notes whether the tab may save, before a later read-only spell
		this.viewerOnly()
		const editor = this.options.editor()
		if (editor && !this.unshown) {
			this.lastScene = { elements: editor.getSceneElementsIncludingDeleted(), files: editor.getFiles() }
		}
		if (this.closed || this.epoch === null || this.timers.keep) {
			return
		}
		this.timers.keep = setTimeout(() => {
			delete this.timers.keep
			this.afterChange()
		}, KEEP_DELAY)
	}

	/**
	 * A peer saved or restored the board
	 *
	 * @param sync
	 */
	hint(sync: BoardSyncState): void {
		if (this.closed || (sync.epoch === this.epoch && sync.rev <= this.rev) || this.timers.hint) {
			return
		}
		// Spread the fetches of a room over a second
		this.timers.hint = setTimeout(() => {
			delete this.timers.hint
			void this.fetch()
		}, 500 + Math.random() * 1000)
	}

	/** Catches up now, for example after a reconnect or when the tab is shown again */
	async fetch(): Promise<void> {
		if (this.closed || this.epoch === null) {
			return
		}
		if (this.fetching) {
			this.fetchAgain = true
			return this.fetching
		}
		const epoch = this.epoch
		this.fetching = (async () => {
			try {
				const response = await this.send('GET', { query: { epoch, since: String(this.rev) } })
				await this.answer(response, epoch)
			} catch {
				// The next poll tries again
			}
		})().finally(() => {
			this.fetching = null
			if (this.fetchAgain) {
				this.fetchAgain = false
				void this.fetch()
			} else {
				this.schedulePoll()
			}
		})
		return this.fetching
	}

	/** Sends what Nextcloud does not have yet */
	async save(): Promise<void> {
		if (this.closed || this.epoch === null || this.options.isReadOnly()) {
			return
		}
		if (this.saving) {
			this.saveAgain = true
			return this.saving
		}
		const repair = this.repairing
		const changes = this.unsaved()
		if (changes.elements.length === 0 && Object.keys(changes.files).length === 0) {
			return
		}

		const epoch = this.epoch
		this.lastSave = this.now()
		this.clearTimer('save')
		this.saveDue = Infinity
		this.saving = (async () => {
			try {
				const response = await this.send('PUT', { body: this.saveBody(changes, repair) })
				if (response.status === 200 && repair) {
					this.repairing = false
				}
				if (await this.answer(response, epoch) && response.body) {
					this.retryDelay = 0
					this.options.announce('saved', response.body.sync)
				} else if (response.status !== 409) {
					this.retryLater()
				}
			} catch {
				this.retryLater()
			}
		})().finally(() => {
			this.saving = null
			if (this.saveAgain) {
				this.saveAgain = false
				this.afterChange()
			}
		})
		return this.saving
	}

	/**
	 * Replaces the board with a version and starts a new epoch; unsaved
	 * changes made before go to the recovery store
	 *
	 * @param content
	 */
	async restore(content: BoardContent): Promise<void> {
		const response = await this.send('POST', {
			path: 'restore',
			body: { schemaVersion: SCENE_SCHEMA_VERSION, data: content },
		})
		if (response.status !== 200 || !response.body) {
			throw new Error(`Could not restore the version (${response.status})`)
		}
		// The board as Nextcloud stored it, which may already be a later restore
		if (this.reloading) {
			await this.reloading
		}
		await this.reload()
		this.options.announce('restored', response.body.sync)
	}

	/**
	 * Adds the unsaved changes kept on this device back to the board, as new edits
	 *
	 * @param recovered
	 */
	async addRecovered(recovered: Changes): Promise<boolean> {
		const editor = this.editor()
		if (!editor || this.closed || this.epoch === null) {
			return false
		}
		const scene = editor.getSceneElementsIncludingDeleted()
		const current = new Map(scene.map((element) => [element.id, element]))
		const readded = (restoreElements(inIndexOrder(recovered.elements), scene) as ExcalidrawElement[]).map((element) => ({
			...element,
			version: Math.max(element.version, current.get(element.id)?.version ?? 0) + 1,
			versionNonce: Math.floor(Math.random() * 2 ** 31),
			updated: Date.now(),
		}))
		const readdedIds = new Set(readded.map((element) => element.id))
		editor.addFiles(Object.values(recovered.files))
		editor.updateScene({
			elements: inIndexOrder([...scene.filter((element) => !readdedIds.has(element.id)), ...readded]),
			captureUpdate: CaptureUpdateAction.IMMEDIATELY,
		})
		// Kept as unsaved before the recovery store lets go of them
		const elements = editor.getSceneElementsIncludingDeleted().filter((element) => readdedIds.has(element.id))
		await this.options.store.keep(this.options.account, this.options.fileId, this.epoch, elements, recovered.files)
		return true
	}

	/** Tells the room which board this tab has, so tabs that are behind fetch */
	announceState(): void {
		if (this.epoch !== null && !this.closed) {
			this.options.announce('saved', { epoch: this.epoch, rev: this.rev })
		}
	}

	/** What this tab has that Nextcloud does not, for a peer that joins the room */
	unsavedChanges(): Changes {
		return this.epoch === null || this.options.isReadOnly() ? { elements: [], files: {} } : this.unsaved()
	}

	/** The tab closes: sends the unsaved changes with a request that outlives the page */
	flush(): void {
		if (this.pendingRecovery.length > 0) {
			void this.keepForRecovery()
		}
		const editor = this.editor()
		if (this.epoch === null || this.viewerOnly() || !editor) {
			return
		}
		this.cacheScene(editor, true)
		const changes = this.unsaved()
		if (changes.elements.length === 0 && Object.keys(changes.files).length === 0) {
			return
		}
		void this.options.store.keep(this.options.account, this.options.fileId, this.epoch, changes.elements, changes.files)
		const body = JSON.stringify(this.saveBody(changes, this.repairing))
		if (body.length <= KEEPALIVE_LIMIT && !this.options.isReadOnly()) {
			void this.options.request('PUT', { body: JSON.parse(body), keepalive: true }).catch(() => {})
		}
	}

	/**
	 * The board closes in this tab: its unsaved changes are sent once a save
	 * still on its way is done
	 */
	close(): void {
		if (this.closed) {
			return
		}
		this.afterChange()
		const editor = this.editor()
		if (editor && this.epoch !== null && !this.viewerOnly()) {
			this.cacheScene(editor, true)
		}
		const changes = this.epoch === null || this.viewerOnly()
			? { elements: [], files: {} }
			: this.unsaved()
		// Sent only while it may save; kept on the device in any case
		const send = !this.options.isReadOnly()
		const body = this.saveBody(changes, this.repairing)
		if (this.epoch !== null && (changes.elements.length > 0 || Object.keys(changes.files).length > 0)) {
			// Kept on the device too, in case the last request fails
			void this.keepAfterClose(this.epoch, changes)
		}
		if (this.pendingRecovery.length > 0) {
			void this.keepForRecovery()
		}
		this.closed = true
		Object.keys(this.timers).forEach((name) => this.clearTimer(name as keyof BoardSync['timers']))
		if (send && (changes.elements.length > 0 || Object.keys(changes.files).length > 0)) {
			void Promise.resolve(this.saving).then(() => this.options.request('PUT', { body })).catch(() => {})
		}
	}

	/** Whether this tab only ever showed the board: it never could save */
	private viewerOnly(): boolean {
		if (!this.options.isReadOnly()) {
			this.wasWritable = true
		}
		return !this.wasWritable
	}

	private afterChange(): void {
		const editor = this.editor()
		if (this.closed || this.epoch === null || !editor) {
			return
		}
		this.converge()
		if (this.viewerOnly()) {
			this.trackAhead(editor)
			return
		}
		if (this.options.isReadOnly()) {
			// Read-only for now: keeps what it has on the device, and looks again until it may save
			const changes = this.unsaved()
			void this.options.store.keep(this.options.account, this.options.fileId, this.epoch, changes.elements, changes.files).catch(() => {})
			this.clearTimer('keep')
			this.timers.keep = setTimeout(() => {
				delete this.timers.keep
				this.afterChange()
			}, 5_000)
			return
		}
		this.cacheScene(editor)

		const changes = this.unsaved()
		void this.options.store.keep(this.options.account, this.options.fileId, this.epoch, changes.elements, changes.files)
		const now = this.now()
		const keys = new Set([...changes.elements.map((element) => element.id), ...Object.keys(changes.files).map((id) => `file:${id}`)])
		this.unsavedSince.forEach((_, key) => keys.has(key) || this.unsavedSince.delete(key))
		keys.forEach((key) => this.unsavedSince.has(key) || this.unsavedSince.set(key, now))
		if (keys.size === 0) {
			return
		}

		const leads = this.options.isLeader() || !this.options.isInRoom() || this.repairing
		const due = leads
			? this.lastSave + LEADER_SAVE_INTERVAL
			: Math.min(...this.unsavedSince.values()) + FALLBACK_SAVE_AFTER
		if (due < this.saveDue && !this.timers.retry) {
			this.clearTimer('save')
			this.saveDue = due
			this.timers.save = setTimeout(() => {
				delete this.timers.save
				this.saveDue = Infinity
				void this.save()
			}, Math.max(0, due - now))
		}
	}

	/**
	 * Handles an answer of Nextcloud to a request sent in `epoch`; returns
	 * whether it brought the tab up to date
	 *
	 * @param response
	 * @param response.status
	 * @param response.body
	 * @param epoch
	 */
	private async answer(response: { status: number, body: ServerAnswer | null }, epoch: string): Promise<boolean> {
		const body = response.body
		if (this.closed || epoch !== this.epoch || !body) {
			return false
		}
		if (response.status === 409 && body.code === 'board_unreadable') {
			this.adopt(body.sync, { elements: [], files: {} })
			this.repairing = true
			this.afterChange()
			return false
		}
		if (response.status === 409 && body.code === 'board_replaced') {
			await this.reload()
			return false
		}
		if (response.status !== 200) {
			return false
		}
		this.provisional = false
		if (body.sync.epoch !== this.epoch) {
			await (body.data ? this.replaceWith(body.sync, body.data) : this.reload())
			return false
		}

		const changes = body.delta ?? body.data ?? { elements: [], files: {} }
		const changed: string[] = []
		for (const element of changes.elements) {
			const known = this.replica.get(element.id)
			if (!known || wins(element, known) || sameStamp(element, known)) {
				this.replica.set(element.id, element)
				changed.push(element.id)
			}
		}
		const files = Object.values(changes.files ?? {}) as BinaryFileData[]
		files.forEach((file) => this.serverFiles.add(file.id))
		this.rev = Math.max(this.rev, body.sync.rev)
		this.converge(changed, files)
		await this.prune()
		return true
	}

	/** The board started a new epoch: show it and keep the unsaved changes */
	private async reload(): Promise<void> {
		if (this.reloading) {
			return this.reloading
		}
		this.reloading = (async () => {
			const loads = this.loads
			const response = await this.send('GET').catch(() => null)
			if (this.closed || loads !== this.loads) {
				// The tab loaded a board meanwhile, maybe a later one
				return
			}
			if (response?.status === 409 && response.body?.code === 'board_unreadable') {
				this.adopt(response.body.sync, { elements: [], files: {} })
				this.repairing = true
				this.afterChange()
			} else if (response?.status === 200 && response.body?.data && response.body.sync.epoch === this.epoch) {
				// Still the same board: merged like any answer, so it cannot take back what was saved since
				await this.answer(response, this.epoch)
			} else if (response?.status === 200 && response.body?.data) {
				await this.replaceWith(response.body.sync, response.body.data)
			} else {
				this.retryLater(() => this.reload())
			}
		})().finally(() => {
			this.reloading = null
		})
		return this.reloading
	}

	private async replaceWith(sync: BoardSyncState, board: BoardContent): Promise<void> {
		if (this.closed) {
			return
		}
		// A text being edited belongs to the board it was started on: it ends there and goes to recovery with the rest
		if (this.options.editor()?.getAppState().editingTextElement) {
			this.options.endEditing?.()
		}
		const unsaved = this.unsaved(true)
		this.adopt(sync, board)
		this.unsavedSince.clear()
		this.deferred.clear()
		this.lastScene = null
		this.clearTimer('keep')
		this.clearTimer('save')
		this.saveDue = Infinity
		// The scene changes with the epoch, before anything can save or keep the old one under the new epoch
		const editor = this.options.editor()
		this.lastBoard = board
		this.unshown = editor ? null : board
		if (editor) {
			this.show(editor, board)
		}
		this.pendingRecovery.push(unsaved)
		await this.keepForRecovery()
	}

	/**
	 * Shows a board that replaces the scene, with what this device kept unsaved
	 * for its epoch, for example while Nextcloud could not be reached
	 *
	 * @param editor
	 * @param board
	 */
	private show(editor: ExcalidrawImperativeAPI, board: BoardContent): void {
		const epoch = this.epoch as string
		editor.addFiles(Object.values(board.files ?? {}))
		editor.updateScene({
			elements: restoreElements(board.elements, null),
			...(board.appState ? { appState: { ...editor.getAppState(), ...sanitizeAppStateForSync(board.appState) } } : {}),
			captureUpdate: CaptureUpdateAction.NEVER,
		})
		// Undoing must not bring back the board from before
		editor.history.clear()
		void this.options.store.kept(this.options.account, this.options.fileId, epoch).catch(() => null).then((kept) => {
			const shown = this.editor()
			if (kept && (kept.elements.length > 0 || Object.keys(kept.files).length > 0) && shown && epoch === this.epoch) {
				shown.addFiles(Object.values(kept.files))
				shown.updateScene({ elements: withKept(shown.getSceneElementsIncludingDeleted(), kept.elements), captureUpdate: CaptureUpdateAction.NEVER })
				this.changed()
			}
		})
	}

	/** The editor of this board, once it shows the board the tab has */
	private editor(): ExcalidrawImperativeAPI | null {
		const editor = this.options.editor()
		if (editor && this.unshown) {
			const board = this.unshown
			this.unshown = null
			this.show(editor, board)
		}
		if (editor && Object.keys(this.unshownFiles).length > 0) {
			const files = Object.values(this.unshownFiles).filter((file) => !editor.getFiles()[file.id])
			this.unshownFiles = {}
			if (files.length > 0) {
				editor.addFiles(files)
			}
		}
		return editor
	}

	/**
	 * Keeps changes for the recovery store, for an edit that finished after
	 * the board it was made on was replaced
	 *
	 * @param changes
	 */
	keepForLater(changes: Changes): void {
		this.pendingRecovery.push(changes)
		void this.keepForRecovery()
	}

	/**
	 * Keeps the last changes of a closed board on the device; while IndexedDB
	 * fails, they stay in memory and it is tried again
	 *
	 * @param epoch
	 * @param changes
	 * @param delay
	 */
	private async keepAfterClose(epoch: string, changes: Changes, delay = 2_000): Promise<void> {
		try {
			await this.options.store.keep(this.options.account, this.options.fileId, epoch, changes.elements, changes.files)
		} catch {
			setTimeout(() => void this.keepAfterClose(epoch, changes, Math.min(delay * 2, MAX_RETRY_DELAY)), delay)
		}
	}

	/**
	 * Moves unsaved changes of earlier epochs to the recovery store. While
	 * IndexedDB fails, they stay in memory and it is tried again.
	 *
	 * @param delay
	 */
	private async keepForRecovery(delay = 2_000): Promise<void> {
		const { account, fileId, store } = this.options
		const pending = this.pendingRecovery.splice(0)
		const unsaved = { elements: pending.flatMap((changes) => changes.elements), files: Object.assign({}, ...pending.map((changes) => changes.files)) }
		try {
			// Changes of any epoch but the one shown now go to recovery; once closed, the board may show a newer one elsewhere
			if (await store.recover(account, fileId, this.closed ? null : (this.epoch ?? ''), unsaved)) {
				this.options.onRecoverable(false)
			}
		} catch {
			// Also after the board closed: the page still holds the only copy
			this.pendingRecovery.unshift(unsaved)
			clearTimeout(this.recoveryRetry)
			this.recoveryRetry = setTimeout(() => void this.keepForRecovery(Math.min(delay * 2, MAX_RETRY_DELAY)), delay)
		}
	}

	/**
	 * Shows the server copies that win over the scene's, unless you are
	 * editing them. On equal stamps with different content (an element
	 * changed without a new version) the server copy wins, so every tab ends
	 * the same. `ids` limits the check to elements that just arrived.
	 *
	 * @param ids
	 * @param files
	 */
	private converge(ids?: string[], files: BinaryFileData[] = []): void {
		const editor = this.editor()
		if (!editor) {
			// Kept for the scene the board opens with
			files.forEach((file) => {
				this.unshownFiles[file.id] = file
			})
			return
		}
		const known = editor.getFiles()
		const newFiles = files.filter((file) => !known[file.id])
		if (newFiles.length > 0) {
			editor.addFiles(newFiles)
		}

		const scene = editor.getSceneElementsIncludingDeleted()
		const local = new Map(scene.map((element) => [element.id, element]))
		const appState = editor.getAppState()
		const editing = new Set([appState.editingTextElement?.id, appState.resizingElement?.id, appState.newElement?.id])
		const newer: ExcalidrawElement[] = []
		const tied: ExcalidrawElement[] = []
		for (const id of ids ?? this.replica.keys()) {
			const server = this.replica.get(id)
			const mine = local.get(id)
			if (!server) {
				continue
			}
			if (editing.has(id)) {
				this.deferred.add(id)
				continue
			}
			if (!mine || wins(server, mine)) {
				newer.push(server)
			} else if ((ids || this.deferred.has(id)) && sameStamp(server, mine)) {
				tied.push(server)
			}
			this.deferred.delete(id)
		}

		const restoredTies = (restoreElements(inIndexOrder(tied), scene) as ExcalidrawElement[]).filter((element) => !isEqual(element, local.get(element.id)))
		if (newer.length === 0 && restoredTies.length === 0) {
			return
		}
		let elements = mergeElementsWithMetadata(scene, restoreElements(inIndexOrder(newer), scene) as ExcalidrawElement[], appState as AppState)
		if (restoredTies.length > 0) {
			const byId = new Map(restoredTies.map((element) => [element.id, element]))
			elements = elements.map((element) => byId.get(element.id) ?? element)
		}
		editor.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
	}

	/**
	 * A read-only tab cannot save. What it got from a writer and Nextcloud
	 * still lacks after the grace period goes back to the stored copy.
	 *
	 * @param editor
	 */
	private trackAhead(editor: ExcalidrawImperativeAPI): void {
		const now = this.now()
		const ahead = new Set(editor.getSceneElementsIncludingDeleted()
			.filter((element) => {
				const server = this.replica.get(element.id)
				return !server || wins(element, server)
			})
			.map((element) => element.id))
		this.aheadSince.forEach((_, id) => ahead.has(id) || this.aheadSince.delete(id))
		ahead.forEach((id) => this.aheadSince.has(id) || this.aheadSince.set(id, now))
		if (ahead.size > 0 && !this.timers.grace) {
			this.timers.grace = setTimeout(() => {
				delete this.timers.grace
				void this.dropUnsavedAhead()
			}, READ_ONLY_GRACE / 4)
		}
	}

	private async dropUnsavedAhead(): Promise<void> {
		await this.fetch()
		const editor = this.editor()
		if (!this.viewerOnly()) {
			// It may save now: what it has is its own to keep
			this.aheadSince.clear()
			return
		}
		if (!editor || this.closed || this.provisional) {
			return
		}
		this.trackAhead(editor)
		const now = this.now()
		const expired = [...this.aheadSince].filter(([, since]) => now - since >= READ_ONLY_GRACE).map(([id]) => id)
		if (expired.length === 0) {
			return
		}
		// Every element Nextcloud has goes back to its copy at once, in index order: copies this tab
		// made itself (Excalidraw re-indexes elements whose indices clash) would otherwise clash again
		const dropped = new Set([...expired, ...[...this.aheadSince.keys()].filter((id) => this.replica.has(id))])
		const scene = editor.getSceneElementsIncludingDeleted()
		const stored = restoreElements(inIndexOrder([...dropped].flatMap((id) => this.replica.get(id) ?? [])), scene) as ExcalidrawElement[]
		const byId = new Map(stored.map((element) => [element.id, element]))
		editor.updateScene({
			elements: inIndexOrder(scene.flatMap((element) => dropped.has(element.id) ? (byId.get(element.id) ?? []) : [element])),
			captureUpdate: CaptureUpdateAction.NEVER,
		})
		dropped.forEach((id) => this.aheadSince.delete(id))
	}

	/** Elements that win over the server's copies, and images Nextcloud lacks */
	/**
	 * What wins over Nextcloud's copy, and the images Nextcloud lacks. For
	 * recovery, also the images of the unsaved elements: the next board may
	 * not have them.
	 *
	 * @param forRecovery
	 */
	private unsaved(forRecovery = false): Changes {
		const editor = this.editor()
		const shown = editor ? { elements: editor.getSceneElementsIncludingDeleted(), files: editor.getFiles() } : this.lastScene
		if (!shown) {
			return { elements: [], files: {} }
		}
		const scene = shown.elements
		const elements = scene.filter((element) => {
			const server = this.replica.get(element.id)
			return this.repairing || !server || wins(element, server)
		})
		const available = shown.files
		const files: BinaryFiles = {}
		for (const element of forRecovery ? elements : scene) {
			const fileId = element.type === 'image' ? element.fileId : null
			if (fileId && (forRecovery || !this.serverFiles.has(fileId)) && available[fileId]?.dataURL) {
				files[fileId] = available[fileId]
			}
		}
		if (forRecovery) {
			Object.assign(files, this.unsaved().files)
		}
		return { elements, files }
	}

	private saveBody(changes: Changes, repair: boolean) {
		return {
			schemaVersion: SCENE_SCHEMA_VERSION,
			sync: { epoch: this.epoch, since: this.rev, repair },
			data: changes,
		}
	}

	private async prune(): Promise<void> {
		if (this.epoch === null) {
			return
		}
		// The board of this epoch, even when another one is loaded before IndexedDB gets to the prune
		const { replica, serverFiles } = this
		await this.options.store.prune(this.options.account, this.options.fileId, this.epoch, (entry) => {
			if (entry.element) {
				const server = replica.get(entry.element.id)
				return Boolean(server) && !wins(entry.element, server as ExcalidrawElement)
			}
			return Boolean(entry.file && serverFiles.has(entry.file.id))
		})
	}

	private adopt(sync: BoardSyncState, board: { elements: readonly ExcalidrawElement[], files?: BinaryFiles }): void {
		if (sync.epoch !== this.epoch) {
			this.unshownFiles = {}
		}
		this.provisional = false
		this.loads++
		this.epoch = sync.epoch
		this.rev = sync.rev
		this.replica = new Map(board.elements.map((element) => [element.id, element]))
		this.serverFiles = new Set(Object.keys(board.files ?? {}))
	}

	private cacheScene(editor: ExcalidrawImperativeAPI, now = false): void {
		const time = this.now()
		if (this.epoch === null) {
			return
		}
		this.clearTimer('cache')
		if (!now && time - this.lastSceneCache < SCENE_CACHE_INTERVAL) {
			// The last change is cached too, a little later
			this.timers.cache = setTimeout(() => {
				delete this.timers.cache
				const shown = this.editor()
				if (shown && !this.closed) {
					this.cacheScene(shown, true)
				}
			}, SCENE_CACHE_INTERVAL - (time - this.lastSceneCache))
			return
		}
		this.lastSceneCache = time
		const elements = editor.getSceneElementsIncludingDeleted()
		const shown = new Map(elements.map((element) => [element.id, element]))
		void this.options.store.saveScene({
			account: this.options.account,
			fileId: this.options.fileId,
			elements,
			files: editor.getFiles(),
			appState: sanitizeAppStateForSync(editor.getAppState()),
			savedAt: time,
			server: {
				epoch: this.epoch,
				rev: this.rev,
				ids: [...this.replica.keys()],
				// Copies not shown yet because they were being edited count as differing too
				differing: [...this.replica.values()].filter((element) => {
					const mine = shown.get(element.id)
					return !mine || !sameStamp(mine, element) || this.deferred.has(element.id)
				}),
				files: [...this.serverFiles],
			},
		}).catch(() => {})
	}

	private schedulePoll(): void {
		if (this.closed) {
			return
		}
		this.clearTimer('poll')
		this.timers.poll = setTimeout(() => {
			delete this.timers.poll
			void this.fetch()
		}, this.options.isInRoom() ? POLL_IN_ROOM : POLL_ALONE)
	}

	private retryLater(retry: () => unknown = () => this.save()): void {
		this.retryDelay = Math.min(MAX_RETRY_DELAY, this.retryDelay ? this.retryDelay * 2 : 2_000)
		this.clearTimer('retry')
		this.timers.retry = setTimeout(() => {
			delete this.timers.retry
			void retry()
		}, this.retryDelay * (0.75 + Math.random() / 2))
	}

	private send(...[method, options]: Parameters<BoardRequest>): ReturnType<BoardRequest> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('The request timed out')), REQUEST_TIMEOUT)
			this.options.request(method, options).then((response) => {
				clearTimeout(timer)
				resolve(response)
			}, (error) => {
				clearTimeout(timer)
				reject(error)
			})
		})
	}

	private clearTimer(name: keyof BoardSync['timers']): void {
		clearTimeout(this.timers[name])
		delete this.timers[name]
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}
}

/**
 * The scene of a board with the unsaved elements this device kept for it
 *
 * @param elements
 * @param kept
 */
function withKept(elements: readonly ExcalidrawElement[], kept: readonly ExcalidrawElement[]): ExcalidrawElement[] {
	const byId = new Map(elements.map((element) => [element.id, element]))
	for (const element of kept) {
		const stored = byId.get(element.id)
		if (!stored || wins(element, stored)) {
			byId.set(element.id, element)
		}
	}
	return inIndexOrder([...byId.values()])
}

let activeBoardSync: BoardSync | null = null

/** The board open in this page */
export function getBoardSync(): BoardSync | null {
	return activeBoardSync
}

export function setBoardSync(sync: BoardSync | null): void {
	if (activeBoardSync && activeBoardSync !== sync) {
		activeBoardSync.close()
	}
	activeBoardSync = sync
	if (typeof window !== 'undefined' && window.__whiteboardTest) {
		window.__whiteboardTestHooks = window.__whiteboardTestHooks || {}
		;(window.__whiteboardTestHooks as Record<string, unknown>).boardSync = sync
	}
}
