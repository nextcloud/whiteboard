/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'
import type { Answer, BoardContent, BoardRequest, BoardRevision, Refusal } from './answer.ts'
import type { BoardSettings, Changes } from './changes.ts'
import type { BoardStore, SceneCache } from './localBoardStore.ts'

import { CaptureUpdateAction, restoreAppState, restoreElements } from '@nextcloud/excalidraw'
import { isEqual, pick } from 'lodash'
import logger from '../utils/logger.ts'
import { mergeElementsWithMetadata } from '../utils/mergeElementsWithMetadata.ts'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState.ts'
import { readAnswer, worthRetrying } from './answer.ts'
import { BOARD_SETTINGS, changeSet, copiesOf, isEmpty } from './changes.ts'
import { inIndexOrder, sameContent, sameStamp, wins } from './elementOrder.ts'
import { SCENE_SCHEMA_VERSION } from './roomMessages.ts'

/** What the tab knows about saving the board, for the people editing it */
export interface BoardSyncStatus {
	/** Nextcloud has not given this tab the board, and this device has no copy of it */
	unavailable: boolean
	/** When the oldest change Nextcloud does not have yet was made; null when it has them all */
	unsavedSince: number | null
	saving: boolean
	/** The last save did not reach Nextcloud; it is tried again, unless Nextcloud refused it */
	failed: boolean
	/** Why the last save did not reach Nextcloud, when the person can do something about it */
	reason: Refusal | null
	/** When Nextcloud last stored a save of this tab */
	savedAt: number | null
}

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
	announce: (type: 'saved' | 'restored', sync: BoardRevision) => void
	/** This device keeps unsaved changes of the board from before its epoch changed (`opened`: found when the board opened) */
	onRecoverable: (opened: boolean) => void
	/** The changes this device keeps for the board */
	store: BoardStore
	/** Ends a text edit in progress, as leaving the text field does */
	endEditing?: () => void
	/** The unsaved draft of the previous client, and how to drop it once it is in the recovery store */
	legacyDraft?: { read: () => Promise<Changes | null>, drop: () => Promise<void> }
	onStatus?: (status: BoardSyncStatus) => void
	/** A request can be sent while the page closes: it does not have to wait for a new token */
	keepaliveReady?: () => boolean
	now?: () => number
}

// The tab the collaboration server picked saves the room's changes this often
const LEADER_SAVE_INTERVAL = 10_000
// Other tabs save what is still unsaved after this long, in case that tab cannot
const FALLBACK_SAVE_AFTER = 30_000
/** A change Nextcloud does not have this long after it was made is late, not just waiting for the next save */
export const UNSAVED_LATE_AFTER = 2 * FALLBACK_SAVE_AFTER
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

let activeBoardSync: BoardSync | null = null
// Boards closed in this page whose last changes Nextcloud does not have yet
const closing = new Set<BoardSync>()

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
	/** The epoch of the board the tab shows: null before it has one, '' while it shows this device's copy of a board whose epoch it does not know */
	epoch: string | null = null
	rev = 0
	status: BoardSyncStatus = { unavailable: false, unsavedSince: null, saving: false, failed: false, reason: null, savedAt: null }

	private replica = new Map<string, ExcalidrawElement>()
	private serverFiles = new Set<string>()
	// The board settings as Nextcloud has them
	private settings: BoardSettings = {}
	// Settings that arrived before the editor was there
	private unshownSettings: BoardSettings = {}
	// Settings this tab kept on the device as unsaved
	private keptSettings = new Set<string>()
	// Copies sent in saves whose answer did not come yet, by save: Nextcloud may have them, which the replica does not show
	private unanswered = new Map<number, ReadonlyMap<string, ExcalidrawElement>>()
	// Of each element that saves sent and got no answer for, the copy that wins: Nextcloud may have it
	private maybeStored = new Map<string, ExcalidrawElement>()
	private sendSeq = 0
	private unsavedSince = new Map<string, number>()
	private aheadSince = new Map<string, number>()
	// Server copies not shown yet because you were editing them
	private deferred = new Set<string>()
	// Elements Nextcloud has that the editor cannot show, for example of a type from a newer version
	private unshowable = new Set<string>()
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
	private lastScene: { elements: readonly ExcalidrawElement[], files: BinaryFiles, settings: BoardSettings } | null = null
	private closed = false
	// The last save of the closed board reached Nextcloud
	private closedSaveLanded = false
	// The changes the board had when it closed, until Nextcloud has them
	private lastChanges: { epoch: string, changes: Changes, keptOnDevice: Promise<void> } | null = null
	private sendingLast: Promise<boolean> | null = null
	private lastChangesRetry: ReturnType<typeof setTimeout> | undefined
	// The body of the last request sent while the page closes, which is not sent twice
	private lastKeepalive: string | null = null
	private timers: Partial<Record<'keep' | 'save' | 'poll' | 'retry' | 'catchUp' | 'hint' | 'grace' | 'cache', ReturnType<typeof setTimeout>>> = {}

	constructor(readonly options: BoardSyncOptions) {
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
		const { store } = this.options
		const answer = readAnswer(await this.options.request('GET').catch(() => null))
		const cached = await store.cachedScene().catch(() => undefined)
		if (this.closed) {
			return null
		}
		if (answer.kind === 'unreadable') {
			this.unreadable(answer.sync, !cached)
			this.schedulePoll()
			return cached ? { elements: [...cached.elements], files: cached.files, appState: cached.appState } : null
		}
		if (answer.kind !== 'ok' || !answer.data) {
			if (answer.kind === 'busy') {
				// Busy for a moment, for example while another tab saves a large board
				this.retryLater(() => this.fetch(), 'catchUp')
			}
			return this.openFromDevice(cached)
		}

		const data = answer.data
		this.adopt(answer.sync, data)
		this.report({ unavailable: false })
		const opened = this.loads
		const kept = await this.keptFor(this.epoch as string)
		if (!this.options.isReadOnly()) {
			const legacy = await this.options.legacyDraft?.read().catch(() => null) ?? undefined
			const recoverable = await store.setAside(this.epoch as string, legacy && unsavedAgainst(legacy, data)).catch(() => null)
			if (recoverable) {
				this.options.onRecoverable(true)
			}
			if (legacy && recoverable !== null) {
				await this.options.legacyDraft?.drop().catch(() => {})
			}
		}
		this.schedulePoll()
		if (this.loads !== opened && this.lastBoard) {
			// Another board replaced this one while it opened
			return this.overtaken()
		}

		return withChanges({
			...data,
			// The replica also has what arrived while the board opened
			elements: [...this.replica.values()],
			files: { ...data.files, ...this.unshownFiles },
			// Settings changed on this device stay, unless the board sets them; its unsaved board settings win
			appState: { ...cached?.appState, ...data.appState, ...this.settings },
		}, kept)
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
		this.settings = server?.settings ?? boardSettings(cached?.appState)
		this.schedulePoll()
		this.report({ unavailable: !cached })
		if (!cached) {
			return null
		}
		const opened = this.loads
		const kept = await this.keptFor(this.epoch)
		if (this.loads !== opened && this.lastBoard) {
			// Nextcloud answered with another board while this one opened
			return this.overtaken()
		}
		return withChanges({ elements: [...cached.elements], files: cached.files, appState: cached.appState }, kept)
	}

	/**
	 * The board that replaced the one being opened, with what this device kept
	 * unsaved for its epoch; the open shows it, so it is not shown again
	 */
	private async overtaken(): Promise<BoardContent> {
		for (;;) {
			const loads = this.loads
			const board = this.lastBoard as BoardContent
			const kept = await this.keptFor(this.epoch as string)
			// Unless yet another board came meanwhile
			if (loads === this.loads) {
				this.unshown = null
				return withChanges({ ...board, files: { ...board.files, ...this.unshownFiles } }, kept)
			}
		}
	}

	/** Call on every change of the scene */
	changed(): void {
		// Notes whether the tab may save, before a later read-only spell
		this.wasWritable ||= !this.options.isReadOnly()
		const editor = this.options.editor()
		if (editor && !this.unshown) {
			this.lastScene = { elements: editor.getSceneElementsIncludingDeleted(), files: editor.getFiles(), settings: pick(editor.getAppState(), BOARD_SETTINGS) }
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
	 * @param sync the epoch and revision it has now; unknown from an older client's restore note
	 */
	hint(sync?: BoardRevision): void {
		if (this.closed || (sync && sync.epoch === this.epoch && sync.rev <= this.rev) || this.timers.hint) {
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
				await this.applyAnswer(readAnswer(await this.options.request('GET', { query: { epoch, since: String(this.rev) } })), epoch)
			} catch (error) {
				// The next poll tries again
				logger.warn('[BoardSync] Could not catch up with Nextcloud', error)
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
		if (isEmpty(changes)) {
			// Nextcloud has everything, also what an earlier save of this tab failed to send
			this.report({ failed: false, reason: null })
			return
		}

		const epoch = this.epoch
		const sent = unsavedKeys(changes)
		this.lastSave = this.now()
		const sentAt = this.lastSave
		this.clearTimer('save')
		this.saveDue = Infinity
		this.report({ saving: true })
		this.saving = (async () => {
			try {
				const seq = this.noteSent(changes.elements)
				// A request that could not be sent is a failed answer, so its copies are settled like any
				const answer = readAnswer(await this.options.request('PUT', { body: this.saveBody(changes, repair) }).catch((error) => {
					logger.warn('[BoardSync] Could not save to Nextcloud', error)
					return null
				}))
				this.settleSent(seq, answer)
				if (answer.kind === 'ok' && repair) {
					this.repairing = false
				}
				if (await this.applyAnswer(answer, epoch) && answer.kind === 'ok') {
					// What is still unsaved of what this save sent changed after it left
					sent.forEach((key) => this.unsavedSince.has(key) && this.unsavedSince.set(key, sentAt))
					this.retryDelay = 0
					this.report({ failed: false, reason: null, savedAt: this.now(), unsavedSince: this.unsavedSince.size > 0 ? Math.min(...this.unsavedSince.values()) : null })
					this.options.announce('saved', answer.sync)
				} else if (answer.kind !== 'ok' && answer.kind !== 'replaced' && answer.kind !== 'unreadable') {
					this.report({ failed: true, reason: answer.kind === 'busy' ? null : answer.reason ?? null })
					if (worthRetrying(answer)) {
						this.retryLater()
					}
				}
			} catch (error) {
				logger.warn('[BoardSync] Could not save to Nextcloud', error)
				this.report({ failed: true, reason: null })
				this.retryLater()
			}
		})().finally(() => {
			this.saving = null
			this.report({ saving: false })
			this.trackUnsaved()
			if (this.saveAgain) {
				this.saveAgain = false
				this.afterChange()
			}
		})
		return this.saving
	}

	/**
	 * Nextcloud restored a version of the board: shows the board in its new
	 * epoch, with unsaved changes made before in the recovery store, and tells
	 * the room
	 */
	async restored(): Promise<void> {
		// The board as Nextcloud has it now, which may already be a later restore
		if (this.reloading) {
			await this.reloading
		}
		await this.reload()
		if (this.epoch !== null && !this.closed) {
			this.options.announce('restored', { epoch: this.epoch, rev: this.rev })
		}
	}

	/**
	 * Adds the changes this device kept for recovery back to the board, then
	 * lets the recovery store go of them; false when the board cannot take
	 * them now, which leaves them kept
	 */
	async addBack(): Promise<boolean> {
		const recovered = await this.options.store.recovered()
		if (!await this.addRecovered(recovered)) {
			return false
		}
		await this.options.store.dropRecovered(recovered.keys)
		return true
	}

	/**
	 * Adds the unsaved changes kept on this device back to the board, as new edits
	 *
	 * @param recovered the changes the recovery store kept
	 */
	async addRecovered(recovered: Changes): Promise<boolean> {
		const editor = this.showPendingInEditor()
		if (!editor || this.closed || this.epoch === null || this.options.isReadOnly()) {
			return false
		}
		const scene = editor.getSceneElementsIncludingDeleted()
		const current = new Map(scene.map((element) => [element.id, element]))
		const changes = recovered.elements.filter((element) => {
			const shown = current.get(element.id)
			return !shown || !sameContent(element, shown)
		})
		const readded = (restoreElements(inIndexOrder(changes), scene) as ExcalidrawElement[]).map((element) => ({
			...element,
			version: Math.max(element.version, current.get(element.id)?.version ?? 0) + 1,
			versionNonce: Math.floor(Math.random() * 2 ** 31),
			updated: this.now(),
		}))
		// Kept as unsaved before they show: a device that cannot keep them shows nothing, and they are offered again.
		// So are the shown copies the recovery store holds the only kept copy of
		const shownAlready = recovered.elements.flatMap((element) => {
			const shown = current.get(element.id)
			return shown && sameContent(element, shown) ? [shown] : []
		})
		const epoch = this.epoch
		await this.options.store.keep(epoch, { elements: [...readded, ...shownAlready], files: recovered.files, settings: recovered.settings })
		if (this.closed || epoch !== this.epoch || this.options.editor() !== editor) {
			return false
		}
		const readdedIds = new Set(readded.map((element) => element.id))
		// Added back as the newest edit of what the board shows now, which may have changed meanwhile
		const landing = new Map(editor.getSceneElementsIncludingDeleted().map((element) => [element.id, element]))
		const shown = readded.map((element) => ({ ...element, version: Math.max(element.version, (landing.get(element.id)?.version ?? 0) + 1) }))
		editor.addFiles(Object.values(recovered.files))
		if (shown.length > 0 || recovered.settings) {
			editor.updateScene({
				...(shown.length > 0 ? { elements: inIndexOrder([...[...landing.values()].filter((element) => !readdedIds.has(element.id)), ...shown]) } : {}),
				...(recovered.settings ? { appState: { ...editor.getAppState(), ...recovered.settings } } : {}),
				captureUpdate: CaptureUpdateAction.IMMEDIATELY,
			})
		}
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
		return this.epoch === null || this.options.isReadOnly() ? changeSet() : this.unsaved()
	}

	/**
	 * The tab closes: sends the unsaved changes with a request that outlives
	 * the page. Returns false when unsaved changes could not go out that way
	 * (too large, or no token to send them with), so the page can ask to stay.
	 */
	flush(): boolean {
		if (this.pendingRecovery.length > 0) {
			void this.keepForRecovery()
		}
		if (this.closed) {
			return this.lastChanges === null || this.sendKeepalive(this.lastChanges.epoch, this.lastChanges.changes, this.lastChanges.keptOnDevice)
		}
		const editor = this.showPendingInEditor()
		if (this.epoch === null || this.viewerOnly() || !editor) {
			return true
		}
		this.cacheScene(editor, true)
		const changes = this.unsaved()
		if (isEmpty(changes)) {
			return true
		}
		const epoch = this.epoch
		const keptOnDevice = this.options.store.keep(epoch, changes).catch(() => {})
		return this.sendKeepalive(epoch, changes, keptOnDevice)
	}

	/**
	 * Sends changes with a request that outlives the page; returns false when
	 * it cannot (too large, or no token to send them with)
	 *
	 * @param epoch
	 * @param changes
	 * @param keptOnDevice settles once the device kept the changes
	 */
	private sendKeepalive(epoch: string, changes: Changes, keptOnDevice: Promise<void>): boolean {
		const payload = this.saveBody(changes, this.repairing, epoch)
		const body = JSON.stringify(payload)
		if (body === this.lastKeepalive) {
			return true
		}
		if (this.options.isReadOnly() || new TextEncoder().encode(body).byteLength > KEEPALIVE_LIMIT || !(this.options.keepaliveReady?.() ?? true)) {
			return false
		}
		this.lastKeepalive = body
		const seq = this.noteSent(changes.elements)
		// The page may live on (a cancelled unload, a board closed in the page), and then sees the answer
		void this.options.request('PUT', { body: payload, keepalive: true })
			.catch(() => null)
			.then(async (response) => {
				const answer = readAnswer(response)
				this.settleSent(seq, answer)
				if (answer.kind !== 'ok') {
					this.lastKeepalive = null
				}
				if (!this.closed) {
					await this.applyAnswer(answer, epoch)
				} else if (answer.kind === 'ok' && answer.sync.epoch === epoch) {
					await this.landedAfterClose(epoch, changes, keptOnDevice)
				}
			})
			.catch(() => {
				// Its answer could not be handled: the next attempt sends it again
				this.lastKeepalive = null
			})
		return true
	}

	/**
	 * The page is hidden, and may be frozen or discarded before any timer
	 * runs: the unsaved changes go to the device and to Nextcloud at once
	 */
	hidden(): void {
		if (!this.flush()) {
			void this.save()
		}
	}

	/** Whether this tab has changes Nextcloud does not have yet, also while it may not save for a while */
	hasUnsavedChanges(): boolean {
		if (this.closed) {
			return this.lastChanges !== null
		}
		return this.epoch !== null && !this.viewerOnly() && !isEmpty(this.unsaved())
	}

	/**
	 * Whether this device keeps changes of the board that Nextcloud does not
	 * have: unsaved ones, and those set aside for recovery
	 */
	async hasUnsavedOnDevice(): Promise<boolean> {
		if (this.hasUnsavedChanges() || this.pendingRecovery.length > 0) {
			return true
		}
		const recovered = await this.options.store.recovered()
		return !isEmpty(recovered)
	}

	/**
	 * Sends the unsaved changes now and waits for Nextcloud; returns whether
	 * it has them all, for example before a logout
	 */
	async saveNow(): Promise<boolean> {
		if (this.closed) {
			return this.sendLastChanges()
		}
		for (let attempt = 0; attempt < 3 && this.hasUnsavedChanges(); attempt++) {
			await this.saving
			await this.save()
			if (this.status.failed) {
				break
			}
		}
		return !this.hasUnsavedChanges()
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
		const editor = this.showPendingInEditor()
		if (editor && this.epoch !== null && !this.viewerOnly()) {
			this.cacheScene(editor, true)
		}
		const changes = this.epoch === null || this.viewerOnly()
			? changeSet()
			: this.unsaved()
		// Sent at once only while it may save; kept on the device in any case
		const send = !this.options.isReadOnly()
		const epoch = this.epoch
		const hasChanges = !isEmpty(changes)
		// Kept on the device too, in case the last request fails
		const keptOnDevice = epoch !== null && hasChanges ? this.keepAfterClose(epoch, changes) : Promise.resolve()
		if (this.pendingRecovery.length > 0) {
			void this.keepForRecovery()
		}
		this.closed = true
		Object.keys(this.timers).forEach((name) => this.clearTimer(name as keyof BoardSync['timers']))
		if (epoch !== null && hasChanges) {
			// Sent until Nextcloud has them, while the page lives; a logout waits for them
			this.lastChanges = { epoch, changes, keptOnDevice }
			closing.add(this)
			if (send) {
				void Promise.resolve(this.saving).then(() => this.sendLastChanges())
			} else {
				this.retryLastChanges()
			}
		}
	}

	/** Sends the changes the board had when it closed; returns whether Nextcloud has them */
	private sendLastChanges(): Promise<boolean> {
		const last = this.lastChanges
		if (!last) {
			return Promise.resolve(true)
		}
		// The board is open again in the page: it takes them from the device, and a later setting must not be taken back
		if (activeBoardSync && activeBoardSync !== this && activeBoardSync.fileId === this.fileId && activeBoardSync.options.account === this.options.account) {
			this.lastChanges = null
			clearTimeout(this.lastChangesRetry)
			closing.delete(this)
			return Promise.resolve(true)
		}
		if (this.sendingLast) {
			return this.sendingLast
		}
		clearTimeout(this.lastChangesRetry)
		this.sendingLast = (async () => {
			const answer = readAnswer(await this.options.request('PUT', { body: this.saveBody(last.changes, this.repairing, last.epoch) }).catch(() => null))
			if (answer.kind === 'ok' && answer.sync.epoch === last.epoch) {
				await this.landedAfterClose(last.epoch, last.changes, last.keptOnDevice)
				return true
			}
			// Replaced by another board, or no longer allowed: the device keeps them for the next open
			if (worthRetrying(answer)) {
				this.retryLastChanges()
			}
			return false
		})().finally(() => {
			this.sendingLast = null
		})
		return this.sendingLast
	}

	private retryLastChanges(): void {
		this.retryDelay = Math.min(MAX_RETRY_DELAY, this.retryDelay ? this.retryDelay * 2 : 2_000)
		clearTimeout(this.lastChangesRetry)
		this.lastChangesRetry = setTimeout(() => void this.sendLastChanges(), this.retryDelay * (0.75 + Math.random() / 2))
	}

	/**
	 * A save of the closed board reached Nextcloud
	 *
	 * @param epoch
	 * @param changes
	 * @param keptOnDevice settles once the device kept the changes
	 */
	private async landedAfterClose(epoch: string, changes: Changes, keptOnDevice: Promise<void>): Promise<void> {
		if (this.lastChanges?.changes === changes) {
			this.lastChanges = null
			clearTimeout(this.lastChangesRetry)
			closing.delete(this)
		}
		this.closedSaveLanded = true
		await keptOnDevice
		await this.options.store.dropSaved(epoch, copiesOf(changes)).catch(() => {})
	}

	/** Whether this tab only ever showed the board: it never could save */
	private viewerOnly(): boolean {
		if (!this.options.isReadOnly()) {
			this.wasWritable = true
		}
		return !this.wasWritable
	}

	private afterChange(): void {
		const editor = this.showPendingInEditor()
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
			void this.options.store.keep(this.epoch, changes).catch(() => {})
			this.clearTimer('keep')
			this.timers.keep = setTimeout(() => {
				delete this.timers.keep
				this.afterChange()
			}, 5_000)
			return
		}
		this.cacheScene(editor)

		const changes = this.unsaved()
		void this.options.store.keep(this.epoch, changes).catch(() => {})
		this.forgetSettingsChangedBack(changes)
		const now = this.now()
		if (this.trackUnsaved(changes) === 0) {
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
	 * @param answer
	 * @param epoch
	 */
	private async applyAnswer(answer: Answer, epoch: string): Promise<boolean> {
		if (this.closed || epoch !== this.epoch) {
			return false
		}
		if (answer.kind === 'unreadable') {
			this.unreadable(answer.sync)
			return false
		}
		if (answer.kind === 'replaced') {
			await this.reload()
			return false
		}
		if (answer.kind !== 'ok') {
			return false
		}
		this.provisional = false
		// Readable again, for example after another tab repaired it
		this.report({ unavailable: false })
		if (answer.sync.epoch !== this.epoch) {
			await (answer.data ? this.replaceWith(answer.sync, answer.data) : this.reload())
			return false
		}

		const changes = answer.delta ?? answer.data ?? changeSet()
		// Settings carry no stamps of their own: an answer about an older revision would take back a later one
		if (answer.sync.rev >= this.rev) {
			this.takeSettings(answer.data ? boardSettings(answer.data.appState) : (answer.delta?.settings ?? {}))
		}
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
		this.rev = Math.max(this.rev, answer.sync.rev)
		this.converge(changed, files)
		this.trackUnsaved()
		// Nextcloud has it either way; the device copy goes with a later answer
		await this.prune().catch(() => {})
		return true
	}

	/**
	 * Notes since when each change Nextcloud does not have was made; returns how many there are
	 *
	 * @param changes what wins over Nextcloud's copy now
	 */
	private trackUnsaved(changes?: Changes): number {
		if (this.closed || this.epoch === null || this.viewerOnly() || (!changes && !this.options.editor())) {
			return 0
		}
		const keys = unsavedKeys(changes ?? this.unsaved())
		const now = this.now()
		this.unsavedSince.forEach((_, key) => keys.has(key) || this.unsavedSince.delete(key))
		keys.forEach((key) => this.unsavedSince.has(key) || this.unsavedSince.set(key, now))
		this.report({ unsavedSince: keys.size > 0 ? Math.min(...this.unsavedSince.values()) : null })
		return keys.size
	}

	/**
	 * Drops the kept copy of settings changed back to Nextcloud's value
	 *
	 * @param changes what wins over Nextcloud's copy now
	 */
	private forgetSettingsChangedBack(changes: Changes): void {
		const unsaved = new Set(Object.keys(changes.settings ?? {}))
		const changedBack = [...this.keptSettings].filter((key) => !unsaved.has(key))
		this.keptSettings = unsaved
		if (changedBack.length === 0 || this.epoch === null) {
			return
		}
		void this.options.store.forgetSettings(this.epoch, changedBack).catch(() => {})
	}

	/**
	 * Takes board settings from Nextcloud and shows those not changed in this tab
	 *
	 * @param settings
	 */
	private takeSettings(settings: BoardSettings): void {
		const editor = this.options.editor()
		const shown = editor && !this.unshown ? editor.getAppState() : null
		const take: BoardSettings = {}
		for (const key of Object.keys(settings) as (keyof BoardSettings)[]) {
			if (isEqual(settings[key], this.settings[key])) {
				continue
			}
			if (!shown || isEqual(shown[key], this.settings[key])) {
				Object.assign(take, { [key]: settings[key] })
			}
			Object.assign(this.settings, { [key]: settings[key] })
		}
		if (Object.keys(take).length === 0) {
			return
		}
		if (shown && editor) {
			editor.updateScene({ appState: { ...shown, ...take }, captureUpdate: CaptureUpdateAction.NEVER })
		} else {
			Object.assign(this.unshownSettings, take)
		}
	}

	private report(change: Partial<BoardSyncStatus>): void {
		const status = { ...this.status, ...change }
		if ((Object.keys(status) as (keyof BoardSyncStatus)[]).every((key) => status[key] === this.status[key])) {
			return
		}
		this.status = status
		this.options.onStatus?.(status)
	}

	/** The board started a new epoch: show it and keep the unsaved changes */
	private async reload(): Promise<void> {
		if (this.reloading) {
			return this.reloading
		}
		this.reloading = (async () => {
			const loads = this.loads
			const answer = readAnswer(await this.options.request('GET').catch(() => null))
			if (this.closed || loads !== this.loads) {
				// The tab loaded a board meanwhile, maybe a later one
				return
			}
			if (answer.kind === 'unreadable') {
				this.unreadable(answer.sync)
			} else if (answer.kind === 'ok' && answer.data && answer.sync.epoch === this.epoch) {
				// Still the same board: merged like any answer, so it cannot take back what was saved since
				await this.applyAnswer(answer, this.epoch)
			} else if (answer.kind === 'ok' && answer.data) {
				await this.replaceWith(answer.sync, answer.data)
			} else if (worthRetrying(answer)) {
				this.retryLater(() => this.reload(), 'catchUp')
			}
		})().finally(() => {
			this.reloading = null
		})
		return this.reloading
	}

	private async replaceWith(sync: BoardRevision, board: BoardContent): Promise<void> {
		if (this.closed) {
			return
		}
		let { carried, recovered, continues } = this.carriedOver(this.unsaved(true), board, sync.restored === true)
		// A text being edited belongs to the board it was started on: unless the new board is a later state of it that keeps
		// the text, it ends there and goes to recovery with the rest
		const editing = this.options.editor()?.getAppState().editingTextElement?.id
		if (editing && (!continues || recovered.elements.some((element) => element.id === editing))) {
			this.options.endEditing?.()
			;({ carried, recovered, continues } = this.carriedOver(this.unsaved(true), board, sync.restored === true))
		}
		const previousEpoch = this.epoch
		this.adopt(sync, board)
		this.report({ unavailable: false })
		this.unanswered.clear()
		this.maybeStored.clear()
		this.unsavedSince.clear()
		this.report({ unsavedSince: null })
		this.deferred.clear()
		this.lastScene = null
		this.clearTimer('keep')
		this.clearTimer('save')
		this.saveDue = Infinity
		// The scene changes with the epoch, before anything can save or keep the old one under the new epoch
		const editor = this.options.editor()
		const shown = !isEmpty(carried) ? withChanges(board, carried) : board
		this.lastBoard = shown
		this.unshown = editor ? null : shown
		if (editor) {
			this.show(editor, shown, continues)
		}
		if (shown !== board) {
			const { store } = this.options
			this.changed()
			// Kept under the new epoch before the copies of the old one go, so neither ends in recovery
			await store.keep(sync.epoch, carried).catch(() => {})
			// Only copies the carried ones supersede: another tab of this browser may have kept a later one
			await store.dropSaved(previousEpoch ?? '', copiesOf(carried)).catch(() => {})
		}
		// What a tab that only ever showed the board has unsaved came from writers, who keep it themselves
		if (!this.viewerOnly()) {
			this.pendingRecovery.push(recovered)
			await this.keepForRecovery()
		}
	}

	/**
	 * Splits the unsaved changes at an epoch change. When the new board takes
	 * back nothing the tab had from Nextcloud (it is a later state of the same
	 * board, for example the file saved under another file id), changes to
	 * elements new on both boards, or whose copy the new board did not touch,
	 * stay unsaved in the new epoch. Everything else, and all of it after a
	 * restore, goes to recovery.
	 *
	 * @param unsaved
	 * @param board
	 * @param restored the new epoch began with a version restore, which nothing carries over
	 */
	private carriedOver(unsaved: Changes, board: BoardContent, restored = false): { carried: Changes, recovered: Changes, continues: boolean } {
		const next = new Map(board.elements.map((element) => [element.id, element]))
		// What Nextcloud may have: its copies, and those of saves whose answer did not come yet
		const knownCopy = (id: string): ExcalidrawElement | undefined => [this.maybeStored, ...this.unanswered.values()].reduce<ExcalidrawElement | undefined>((known, sent) => {
			const copy = sent.get(id)
			return !copy || (known && !wins(copy, known)) ? known : copy
		}, this.replica.get(id))
		const sentIds = [this.maybeStored, ...this.unanswered.values()].flatMap((sent) => [...sent.keys()])
		const revertsNothing = !restored && !this.repairing && [...new Set([...this.replica.keys(), ...sentIds])].every((id) => {
			const element = knownCopy(id) as ExcalidrawElement
			const copy = next.get(id)
			return copy !== undefined && (wins(copy, element) || (sameStamp(copy, element) && sameContent(copy, element)))
		})
		if (!revertsNothing || this.viewerOnly()) {
			return { carried: changeSet(), recovered: unsaved, continues: false }
		}
		const carried: ExcalidrawElement[] = []
		const recovered: ExcalidrawElement[] = []
		for (const element of unsaved.elements) {
			const copy = next.get(element.id)
			const known = knownCopy(element.id)
			// New on both boards, or the new board still has exactly the copy the change started from
			const copyUntouched = known ? copy !== undefined && sameStamp(copy, known) && sameContent(copy, known) : !copy
			;(copyUntouched ? carried : recovered).push(element)
		}
		const files = (elements: ExcalidrawElement[]) => Object.fromEntries(elements.flatMap((element) => {
			const fileId = element.type === 'image' ? element.fileId : null
			return fileId && unsaved.files[fileId] ? [[fileId, unsaved.files[fileId]]] : []
		})) as BinaryFiles
		// Like elements, a setting carries over only when the new board left it as the tab knew it
		const nextSettings = boardSettings(board.appState)
		const settings = Object.entries(unsaved.settings ?? {})
		const settingUntouched = (key: string) => isEqual(nextSettings[key as keyof BoardSettings], this.settings[key as keyof BoardSettings])
		const carriedSettings = Object.fromEntries(settings.filter(([key]) => settingUntouched(key))) as BoardSettings
		const recoveredSettings = Object.fromEntries(settings.filter(([key]) => !settingUntouched(key))) as BoardSettings
		return {
			carried: changeSet(carried, files(carried), carriedSettings),
			recovered: changeSet(recovered, files(recovered), recoveredSettings),
			continues: true,
		}
	}

	/**
	 * Shows a board that replaces the scene, with what this device kept unsaved
	 * for its epoch, for example while Nextcloud could not be reached
	 *
	 * @param editor
	 * @param board
	 * @param continues a later state of the board shown: the view and the undo history stay
	 */
	private show(editor: ExcalidrawImperativeAPI, board: BoardContent, continues = false): void {
		const epoch = this.epoch as string
		// Settings the board does not set are Excalidraw's defaults, as Nextcloud's copy has them
		const settings = boardSettings(board.appState)
		editor.addFiles(Object.values(board.files ?? {}))
		editor.updateScene({
			elements: restoreElements(board.elements, null),
			appState: { ...editor.getAppState(), ...(continues ? {} : sanitizeAppStateForSync(board.appState)), ...settings },
			captureUpdate: CaptureUpdateAction.NEVER,
		})
		if (!continues) {
			// Undoing must not bring back the board from before
			editor.history.clear()
		}
		void this.keptFor(epoch).then((kept) => {
			const shown = this.showPendingInEditor()
			if (!isEmpty(kept) && shown && epoch === this.epoch) {
				shown.addFiles(Object.values(kept.files))
				shown.updateScene({
					elements: withKept(shown.getSceneElementsIncludingDeleted(), kept.elements),
					...(kept.settings ? { appState: { ...shown.getAppState(), ...kept.settings } } : {}),
					captureUpdate: CaptureUpdateAction.NEVER,
				})
				this.changed()
			}
		})
	}

	/**
	 * What this device kept unsaved for an epoch, to show with the board. A
	 * tab that cannot save shows the board as Nextcloud has it, and leaves
	 * what the device kept to one that can.
	 *
	 * @param epoch
	 */
	private async keptFor(epoch: string): Promise<Changes> {
		return this.viewerOnly() ? changeSet() : this.options.store.claimKept(epoch).catch(() => changeSet())
	}

	/**
	 * The editor of this board, after it shows what arrived before the editor
	 * existed (the board, its settings and its images), so a call may change the scene
	 */
	private showPendingInEditor(): ExcalidrawImperativeAPI | null {
		const editor = this.options.editor()
		if (editor && this.unshown) {
			const board = this.unshown
			this.unshown = null
			this.show(editor, board)
		}
		if (editor && Object.keys(this.unshownSettings).length > 0) {
			const settings = this.unshownSettings
			this.unshownSettings = {}
			editor.updateScene({ appState: { ...editor.getAppState(), ...settings }, captureUpdate: CaptureUpdateAction.NEVER })
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
	 * Notes copies a save sends; returns the save's number
	 *
	 * @param elements
	 */
	private noteSent(elements: readonly ExcalidrawElement[]): number {
		const seq = ++this.sendSeq
		this.unanswered.set(seq, new Map(elements.map((element) => [element.id, element])))
		return seq
	}

	/**
	 * Forgets the copies of a save once its answer tells whether Nextcloud has
	 * them: stored, then in the replica, or not stored by this save. Without an
	 * answer they may be stored or not, and the winning copy of each element
	 * stays noted; the same copies other saves sent stay until their own answers.
	 *
	 * @param seq
	 * @param answer
	 */
	private settleSent(seq: number, answer: Answer): void {
		const sent = this.unanswered.get(seq)
		this.unanswered.delete(seq)
		if (answer.kind === 'failed') {
			sent?.forEach((element, id) => {
				const known = this.maybeStored.get(id)
				if (!known || wins(element, known)) {
					this.maybeStored.set(id, element)
				}
			})
		}
	}

	/**
	 * Nextcloud cannot read the stored board. A tab that shows the board saves
	 * its whole scene over it; a covered one stays covered, as only an empty
	 * board would replace the stored bytes.
	 *
	 * @param sync
	 * @param covered
	 */
	private unreadable(sync: BoardRevision, covered = this.status.unavailable): void {
		this.adopt(sync, changeSet())
		if (covered) {
			this.report({ unavailable: true })
			return
		}
		this.repairing = true
		this.afterChange()
	}

	/**
	 * Keeps changes for the recovery store, for an edit that finished after
	 * the board it was made on was replaced
	 *
	 * @param changes
	 */
	setAsideForRecovery(changes: Changes): void {
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
		if (this.closedSaveLanded) {
			return
		}
		try {
			await this.options.store.keep(epoch, changes)
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
		const pending = this.pendingRecovery.splice(0)
		const unsaved = changeSet(
			pending.flatMap((part) => part.elements),
			Object.assign({}, ...pending.map((part) => part.files)),
			Object.assign({}, ...pending.map((part) => part.settings ?? {})),
		)
		try {
			// Changes of any epoch but the one shown now go to recovery; once closed, the board may show a newer one elsewhere
			if (await this.options.store.setAside(this.closed ? null : (this.epoch ?? ''), unsaved)) {
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
		const editor = this.showPendingInEditor()
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
			if (!server || (!mine && this.unshowable.has(id))) {
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
		const restored = restoreElements(inIndexOrder(newer), scene) as ExcalidrawElement[]
		const shown = new Set(restored.map((element) => element.id))
		newer.forEach((element) => shown.has(element.id) || this.unshowable.add(element.id))
		if (restored.length === 0 && restoredTies.length === 0) {
			return
		}
		let elements = mergeElementsWithMetadata(scene, restored, appState as AppState)
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
		const editor = this.showPendingInEditor()
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

	/**
	 * What wins over Nextcloud's copy, and the images Nextcloud lacks. For
	 * recovery, also the images of the unsaved elements: the next board may
	 * not have them.
	 *
	 * @param forRecovery
	 */
	private unsaved(forRecovery = false): Changes {
		const editor = this.showPendingInEditor()
		const shown = editor ? { elements: editor.getSceneElementsIncludingDeleted(), files: editor.getFiles(), settings: pick(editor.getAppState(), BOARD_SETTINGS) } : this.lastScene
		if (!shown) {
			return changeSet()
		}
		const settings = Object.fromEntries(Object.entries(shown.settings).filter(([key, value]) => !isEqual(value, this.settings[key as keyof BoardSettings]))) as BoardSettings
		const scene = shown.elements
		const elements = scene.filter((element) => {
			const server = this.replica.get(element.id)
			return this.repairing || !server || wins(element, server)
		})
		const available = shown.files
		const files: BinaryFiles = {}
		const unsavedIds = new Set(elements.map((element) => element.id))
		for (const element of scene) {
			const fileId = element.type === 'image' ? element.fileId : null
			if (fileId && (!this.serverFiles.has(fileId) || (forRecovery && unsavedIds.has(element.id))) && available[fileId]?.dataURL) {
				files[fileId] = available[fileId]
			}
		}
		return changeSet(elements, files, settings)
	}

	private saveBody(changes: Changes, repair: boolean, epoch = this.epoch) {
		return {
			schemaVersion: SCENE_SCHEMA_VERSION,
			sync: { epoch, since: this.rev, repair },
			data: changes,
		}
	}

	private async prune(): Promise<void> {
		if (this.epoch === null) {
			return
		}
		// The board of this epoch, even when another one is loaded before IndexedDB gets to the prune
		const { replica, serverFiles, settings } = this
		await this.options.store.dropSaved(this.epoch, { elements: replica, files: serverFiles, settings })
	}

	private adopt(sync: BoardRevision, board: { elements: readonly ExcalidrawElement[], files?: BinaryFiles, appState?: Partial<AppState> }): void {
		if (sync.epoch !== this.epoch) {
			this.unshownFiles = {}
			this.unshownSettings = {}
			this.unshowable.clear()
		}
		this.settings = boardSettings(board.appState)
		this.provisional = false
		this.loads++
		this.epoch = sync.epoch
		this.rev = sync.rev
		this.replica = new Map(board.elements.map((element) => [element.id, element]))
		this.serverFiles = new Set(Object.keys(board.files ?? {}))
	}

	private cacheScene(editor: ExcalidrawImperativeAPI, immediately = false): void {
		const time = this.now()
		if (this.epoch === null) {
			return
		}
		this.clearTimer('cache')
		if (!immediately && time - this.lastSceneCache < SCENE_CACHE_INTERVAL) {
			// The last change is cached too, a little later
			this.timers.cache = setTimeout(() => {
				delete this.timers.cache
				const shown = this.showPendingInEditor()
				if (shown && !this.closed) {
					this.cacheScene(shown, true)
				}
			}, SCENE_CACHE_INTERVAL - (time - this.lastSceneCache))
			return
		}
		this.lastSceneCache = time
		const elements = editor.getSceneElementsIncludingDeleted()
		const shown = new Map(elements.map((element) => [element.id, element]))
		void this.options.store.cacheScene({
			elements,
			files: editor.getFiles(),
			appState: sanitizeAppStateForSync(editor.getAppState()),
			cachedAt: time,
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
				settings: this.settings,
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

	/**
	 * Tries again with backoff: a save on `retry`, which the next save waits
	 * for, a fetch or reload on `catchUp`, which edits do not wait for
	 *
	 * @param retry what to try again
	 * @param timer the timer it waits on
	 */
	private retryLater(retry: () => unknown = () => this.save(), timer: 'retry' | 'catchUp' = 'retry'): void {
		this.retryDelay = Math.min(MAX_RETRY_DELAY, this.retryDelay ? this.retryDelay * 2 : 2_000)
		this.clearTimer(timer)
		this.timers[timer] = setTimeout(() => {
			delete this.timers[timer]
			void retry()
		}, this.retryDelay * (0.75 + Math.random() / 2))
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
 * Keys of what is unsaved, for noting since when
 *
 * @param changes
 * @param changes.elements
 * @param changes.files
 * @param changes.settings
 */
function unsavedKeys({ elements, files, settings }: Changes): Set<string> {
	return new Set([...elements.map((element) => element.id), ...Object.keys(files).map((id) => `file:${id}`), ...Object.keys(settings ?? {}).map((key) => `setting:${key}`)])
}

/**
 * The settings of a board, with Excalidraw's defaults for those it does not set
 *
 * @param appState
 */
function boardSettings(appState?: Partial<AppState>): BoardSettings {
	return pick(restoreAppState(appState ?? {}, null), BOARD_SETTINGS)
}

/**
 * What of a draft without an epoch Nextcloud does not have: elements that
 * win over the stored copy and look different, and the images they use
 *
 * @param draft
 * @param board
 */
function unsavedAgainst(draft: Changes, board: BoardContent): Changes {
	const stored = new Map(board.elements.map((element) => [element.id, element]))
	const elements = draft.elements.filter((element) => {
		const copy = stored.get(element.id)
		return !copy || (wins(element, copy) && !sameContent(element, copy))
	})
	const files: BinaryFiles = {}
	for (const element of elements) {
		const fileId = element.type === 'image' ? element.fileId : null
		if (fileId && draft.files[fileId] && !board.files?.[fileId]) {
			files[fileId] = draft.files[fileId]
		}
	}
	return { elements, files }
}

/**
 * A board with changes this device has for it: an element where it wins over
 * the board's copy, every image and every setting
 *
 * @param board the board as Nextcloud or the device has it
 * @param changes what this device has for it
 */
function withChanges(board: BoardContent, changes: Changes): BoardContent {
	return {
		...board,
		elements: withKept(board.elements, changes.elements),
		files: { ...board.files, ...changes.files },
		appState: { ...board.appState, ...changes.settings },
	}
}

/**
 * The scene of a board with the unsaved elements this device kept for it
 *
 * @param elements the board's elements
 * @param kept the elements this device kept unsaved
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

/** The boards a page that closes or logs out may still have changes of: the open one, and closed ones */
export function getLeavingBoards(): BoardSync[] {
	return [...new Set([activeBoardSync, ...closing])].filter((sync): sync is BoardSync => sync !== null)
}

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
