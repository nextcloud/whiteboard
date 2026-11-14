/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import 'fake-indexeddb/auto'

// Excalidraw's reconcile: the higher version wins, equal versions the lower nonce; an element being edited keeps the local copy.
// Its restore gives an element out of fractional index order a new index and a new version.
vi.mock('@nextcloud/excalidraw', () => ({
	CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
	restoreAppState: (appState) => ({ viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, ...appState }),
	// It drops elements of a type it does not know, as Excalidraw does
	restoreElements: (elements) => {
		let last = null
		return (elements ?? []).filter((element) => element.type !== 'unknown-type').map((element) => {
			const copy = { ...element }
			if (typeof copy.index === 'string') {
				if (last !== null && copy.index <= last) {
					copy.index = `${last}V`
					copy.version += 1
					copy.versionNonce += 1
				}
				last = copy.index
			}
			return copy
		})
	},
	reconcileElements: (local, remote, appState) => {
		const byId = new Map(local.map((element) => [element.id, element]))
		const editing = new Set([appState.editingTextElement?.id, appState.resizingElement?.id, appState.newElement?.id])
		for (const element of remote) {
			const mine = byId.get(element.id)
			const keepMine = mine && (editing.has(mine.id) || mine.version > element.version
				|| (mine.version === element.version && mine.versionNonce <= element.versionNonce))
			if (!keepMine) {
				byId.set(element.id, element)
			}
		}
		return [...byId.values()]
	},
}))

const { BoardSync, getLeavingBoards, setBoardSync } = await import('../../src/sync/boardSync.ts')
const { wins } = await import('../../src/sync/elementOrder.ts')
const { localBoardStore } = await import('../../src/sync/localBoardStore.ts')
// The answers of tests/Unit/Controller/WhiteboardControllerTest.php
const { answers } = JSON.parse(readFileSync(new URL('../fixtures/board-sync-contract.json', import.meta.url), 'utf8'))

const box = (id, version, nonce = version, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: nonce, isDeleted: false, ...extra })

/** Nextcloud as the engine sees it: merges saves by Excalidraw's order, revisions, epochs */
function fakeNextcloud() {
	const server = {
		epoch: 'e1',
		rev: 1,
		elements: new Map(),
		revs: new Map(),
		files: {},
		fileRevs: new Map(),
		settings: {},
		settingRevs: new Map(),
		unreadable: false,
		requests: [],
		hold: null,
		// Saves answered as busy before one gets through
		failPuts: 0,
		putAnswer: null,
		putAnswersLeft: 0,
		// Reads answered as busy before one gets through
		busyGets: 0,
		// How long each answer takes
		delay: 0,
		// Epochs that began with a version restore
		restoredEpochs: new Set(),
		// Saves are stored, but their answers wait for this
		holdAnswers: null,
		changesSince(since) {
			const settings = Object.fromEntries(Object.entries(server.settings).filter(([key]) => server.settingRevs.get(key) > since))
			return {
				elements: [...server.elements.values()].filter((element) => server.revs.get(element.id) > since),
				files: Object.fromEntries(Object.entries(server.files).filter(([id]) => server.fileRevs.get(id) > since)),
				...(Object.keys(settings).length > 0 ? { settings } : {}),
			}
		},
		board() {
			return { elements: [...server.elements.values()], files: { ...server.files }, appState: { ...server.settings } }
		},
		// As WhiteboardContentService::merge: a setting changed after `since`, which the sender did not know, stays
		write(elements, files, settings = {}, since = Infinity) {
			const rev = server.rev + 1
			let changed = false
			for (const [key, value] of Object.entries(settings)) {
				if ((server.settingRevs.get(key) ?? 0) > since) {
					continue
				}
				if (server.settings[key] !== value) {
					server.settings[key] = value
					server.settingRevs.set(key, rev)
					changed = true
				}
			}
			for (const element of elements) {
				const stored = server.elements.get(element.id)
				if (!stored || wins(element, stored)) {
					server.elements.set(element.id, element)
					server.revs.set(element.id, rev)
					changed = true
				}
			}
			for (const [id, file] of Object.entries(files)) {
				if (!server.files[id]) {
					server.files[id] = file
					server.fileRevs.set(id, rev)
					changed = true
				}
			}
			if (changed) {
				server.rev = rev
			}
		},
		// Someone else wrote bytes that are not a board: as the server, a new epoch with nothing readable in it
		corrupt(epoch = 'e-unreadable') {
			server.replace([], epoch)
			server.unreadable = true
		},
		// Someone else wrote the whole file, as an upload or a version restore does
		replace(elements, epoch = 'e2', { files = {}, settings = {} } = {}) {
			server.epoch = epoch
			server.rev += 1
			server.elements = new Map(elements.map((element) => [element.id, element]))
			server.revs = new Map(elements.map((element) => [element.id, server.rev]))
			server.files = { ...files }
			server.fileRevs = new Map(Object.keys(files).map((id) => [id, server.rev]))
			server.settings = { ...settings }
			server.settingRevs = new Map(Object.keys(settings).map((key) => [key, server.rev]))
		},
		// The next `times` saves get this answer, without reaching the board
		answerPuts(answer, times = Infinity) {
			server.putAnswer = answer
			server.putAnswersLeft = times
		},
		async request(method, { query, body, path, keepalive } = {}) {
			server.requests.push({ method, query, body, path, keepalive })
			if (method === 'PUT' && server.putAnswersLeft > 0) {
				server.putAnswersLeft--
				return server.putAnswer
			}
			if (server.hold) {
				await server.hold
			}
			if (server.delay) {
				await new Promise((resolve) => setTimeout(resolve, server.delay))
			}
			const sync = { epoch: server.epoch, rev: server.rev, ...(server.restoredEpochs.has(server.epoch) ? { restored: true } : {}) }
			if ((method === 'PUT' && server.failPuts > 0 && server.failPuts--) || (method === 'GET' && server.busyGets > 0 && server.busyGets--)) {
				return { status: answers.busy.status, body: { code: answers.busy.code } }
			}
			// As Nextcloud: a save from another epoch is told so before it hears the board cannot be read
			if (server.unreadable && (method === 'GET' || (body.sync.epoch === server.epoch && !body.sync.repair))) {
				return { status: answers.unreadable.status, body: { code: answers.unreadable.code, sync } }
			}
			if (method === 'GET') {
				if (query && query.epoch === server.epoch && Number(query.since) <= server.rev) {
					return { status: 200, body: { sync, delta: server.changesSince(Number(query.since)) } }
				}
				return { status: 200, body: { sync, data: server.board() } }
			}
			if (body.sync.epoch !== server.epoch) {
				return { status: answers.replaced.status, body: { code: answers.replaced.code, sync } }
			}
			if (body.sync.repair) {
				server.unreadable = false
			}
			server.write(body.data.elements, body.data.files, body.data.settings, body.sync.since)
			const answer = { status: 200, body: { sync: { ...sync, rev: server.rev }, delta: server.changesSince(body.sync.since) } }
			if (server.holdAnswers) {
				await server.holdAnswers
			}
			return answer
		},
	}
	return server
}

function fakeEditor(elements = []) {
	const editor = {
		elements,
		files: {},
		appState: {},
		updates: 0,
		getSceneElementsIncludingDeleted: () => editor.elements,
		getFiles: () => editor.files,
		getAppState: () => editor.appState,
		updateScene: ({ elements, appState }) => {
			if (elements) {
				editor.elements = elements
			}
			if (appState) {
				editor.appState = appState
			}
			editor.updates++
		},
		// As Excalidraw: an image it has already keeps its bytes
		addFiles: (files) => files.forEach((file) => {
			editor.files[file.id] ??= file
		}),
		history: { clear: vi.fn() },
		edit: (element) => {
			editor.elements = [...editor.elements.filter((other) => other.id !== element.id), element]
		},
	}
	return editor
}

// The changes this device keeps for the board, as one browser: tabs of a test that share a store share its rows
let browsers = 0
function deviceStore() {
	const account = `alice-${++browsers}`
	return Object.assign(localBoardStore.board(account, 1), { account })
}

/** The rows a store keeps for the board: unsaved changes per epoch, and changes kept for recovery */
async function rowsOf(store) {
	const ofBoard = (row) => row.account === store.account && row.fileId === 1
	return {
		outbox: (await localBoardStore.outbox.filter(ofBoard).toArray()).map(({ epoch, element, file, settings }) => ({ epoch, ...(element ? { element } : {}), ...(file ? { file } : {}), ...(settings ? { settings } : {}) })),
		recovery: (await localBoardStore.recovery.filter(ofBoard).toArray()).map(({ epoch, elements, files, settings }) => ({ ...(epoch ? { epoch } : {}), elements, files, ...(settings && Object.keys(settings).length > 0 ? { settings } : {}) })),
	}
}

function setup({ server = fakeNextcloud(), editor = fakeEditor(), readOnly = false, leader = true, inRoom = true, legacy = null, dropLegacy = vi.fn(async () => {}), scene, endEditing, store = deviceStore() } = {}) {
	if (scene) {
		store.cachedScene = async () => scene
	}
	const announced = []
	const recoverable = vi.fn()
	const statuses = []
	const sync = new BoardSync({
		onStatus: (status) => statuses.push(status),
		fileId: 1,
		account: 'alice',
		request: (method, options) => server.request(method, options),
		editor: () => editor,
		isReadOnly: () => typeof readOnly === 'function' ? readOnly() : readOnly,
		isLeader: () => leader,
		isInRoom: () => inRoom,
		announce: (type, state) => announced.push({ type, ...state }),
		onRecoverable: recoverable,
		store,
		legacyDraft: { read: async () => legacy, drop: dropLegacy },
		endEditing: () => endEditing?.(editor),
	})
	return { sync, server, editor, store, announced, recoverable, statuses }
}

// IndexedDB runs on real macrotasks, which fake timers do not run: each step lets it finish
async function idle() {
	for (let i = 0; i < 25; i++) {
		await new Promise((resolve) => setImmediate(resolve))
	}
}

async function advance(ms) {
	await idle()
	await vi.advanceTimersByTimeAsync(ms)
	await idle()
}

const settle = () => advance(400)
const sent = (server) => server.requests.filter((request) => request.method === 'PUT').map((request) => request.body.data.elements.map((element) => `${element.id}@${element.version}`))

// Lets the engine and IndexedDB go on until the test reached the point it waits for; fails when it never does
async function reached(condition) {
	for (let i = 0; i < 100 && !condition(); i++) {
		await new Promise((resolve) => setImmediate(resolve))
	}
	expect(Boolean(condition())).toBe(true)
}

describe('BoardSync', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('sends only what wins over the stored copy, once', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('b', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements

		editor.edit(box('b', 2))
		sync.changed()
		await settle()
		sync.changed()
		await advance(15_000)

		expect(sent(server)).toEqual([['b@2']])
		expect(server.elements.get('b').version).toBe(2)
	})

	it('never removes or lowers a stored element when a tab saves a stale scene', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const stale = setup({ server })
		stale.editor.elements = (await stale.sync.open()).elements
		// Another tab saves a newer copy of a and a new element meanwhile
		server.write([box('a', 5), box('c', 1)], {})

		stale.editor.edit(box('d', 1))
		stale.sync.changed()
		await settle()

		expect([...server.elements.values()].map((element) => `${element.id}@${element.version}`)).toEqual(['a@5', 'c@1', 'd@1'])
		// The save answers with what the tab missed
		expect(stale.editor.elements.map((element) => `${element.id}@${element.version}`).sort()).toEqual(['a@5', 'c@1', 'd@1'])
	})

	it('shows a newer stored copy once you stop editing the element', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { editingTextElement: { id: 'a' } }
		server.write([box('a', 9)], {})

		await sync.fetch()
		expect(editor.elements[0].version).toBe(1)

		editor.appState = {}
		sync.changed()
		await settle()
		expect(editor.elements[0].version).toBe(9)
		// The older copy is not sent: the server has a newer one
		expect(sent(server)).toEqual([])
	})

	it('shows the elements it catches up on as stored, whatever order the server sends them in', async () => {
		const server = fakeNextcloud()
		server.write([box('below', 1, 1, { index: 'a0' }), box('above', 1, 1, { index: 'a1' })], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.write([box('above', 2, 2, { index: 'a1' })], {})
		server.write([box('below', 2, 2, { index: 'a0' })], {})
		// Nextcloud answers from its cache with the changes of each write in turn
		const changesSince = server.changesSince
		server.changesSince = (since) => ({ ...changesSince(since), elements: changesSince(since).elements.reverse() })

		await sync.fetch()

		expect(editor.elements.map((element) => `${element.id}@${element.version}:${element.index}`).sort()).toEqual(['above@2:a1', 'below@2:a0'])
		expect(sync.unsavedChanges().elements).toEqual([])
	})

	it('takes the stored copy when an element has the same version and nonce but other content', async () => {
		const server = fakeNextcloud()
		server.write([box('t', 2, 2, { width: 10 })], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		// Another tab changed the element without a new stamp; the server kept its copy
		editor.edit(box('t', 2, 2, { width: 99 }))
		server.rev += 1
		server.revs.set('t', server.rev)

		await sync.fetch()

		expect(editor.elements[0].width).toBe(10)
	})

	it('loads the board of a new epoch and keeps unsaved elements for recovery', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store, recoverable } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 7))
		// Restored before the edit was saved: the board is the version, in a new epoch
		server.replace([box('v', 1)])

		await sync.save()

		expect(editor.elements.map((element) => element.id)).toEqual(['v'])
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`)).toContain('a@7')
		expect(recoverable).toHaveBeenCalled()
		expect([...server.elements.keys()]).toEqual(['v'])
		expect(editor.history.clear).toHaveBeenCalled()
	})

	it('ignores an answer to a request sent before the epoch changed', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		let release
		server.hold = new Promise((resolve) => {
			release = resolve
		})
		const fetching = sync.fetch()
		server.hold = null
		server.replace([box('r', 1)], 'e2')
		await sync.restored()
		release()
		await fetching

		expect(sync.epoch).toBe(server.epoch)
		expect(editor.elements.map((element) => element.id)).toEqual(['r'])
	})

	it('saves the unsaved elements itself when the tab picked to save does not', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements

		editor.edit(box('x', 1))
		sync.changed()
		await advance(20_000)
		expect(sent(server)).toEqual([])

		await advance(11_000)
		expect(sent(server)).toEqual([['x@1']])
	})

	it('does not send what a peer already saved', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		// Received from a peer over the relay, saved by that peer
		editor.edit(box('p', 1))
		server.write([box('p', 1)], {})
		sync.changed()
		sync.hint({ epoch: server.epoch, rev: server.rev })
		await advance(40_000)

		expect(sent(server)).toEqual([])
	})

	it('fetches the board when a restore note does not tell its revision, and not when it has the one the note tells', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const reads = () => server.requests.filter((request) => request.method === 'GET').length
		const before = reads()

		sync.hint({ epoch: server.epoch, rev: server.rev })
		await advance(2_000)
		expect(reads()).toBe(before)

		// An older client restored the board
		sync.hint()
		await advance(2_000)
		expect(reads()).toBe(before + 1)
	})

	it('shows the stored copy on a read-only tab when a writer never saved an element', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements
		// From a writer over the relay; the writer closed before saving
		editor.edit(box('a', 4))
		editor.edit(box('n', 1))
		sync.changed()
		await advance(100_000)
		expect(editor.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@4', 'n@1'])

		await advance(60_000)
		expect(editor.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
		expect(sent(server)).toEqual([])
	})

	it('repairs a board whose stored bytes cannot be read with the whole scene', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.corrupt()

		editor.edit(box('b', 1))
		sync.changed()
		await settle()
		await advance(11_000)

		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
	})

	it('keeps a draft of the previous client for recovery instead of merging it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const dropLegacy = vi.fn(async () => {})
		const { sync, store, recoverable } = setup({ server, legacy: { elements: [box('a', 30, 30, { x: 5 })], files: {} }, dropLegacy })

		const data = await sync.open()

		expect(data.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
		expect((await rowsOf(store)).recovery[0].elements[0].version).toBe(30)
		expect(recoverable).toHaveBeenCalled()
		expect(dropLegacy).toHaveBeenCalled()
	})

	it('keeps the draft of the previous client where it is when the recovery store fails', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const dropLegacy = vi.fn(async () => {})
		const { sync, store } = setup({ server, legacy: { elements: [box('a', 30)], files: {} }, dropLegacy })
		store.setAside = async () => {
			throw new Error('QuotaExceededError')
		}

		const data = await sync.open()

		expect(data.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
		expect(dropLegacy).not.toHaveBeenCalled()
	})

	it('saves nothing of the board it replaces under the new epoch', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.replace([box('b', 1)])
		// IndexedDB is slow to keep the unsaved changes
		let finishRecovery = null
		store.setAside = () => new Promise((resolve) => {
			finishRecovery = resolve
		})

		const fetching = sync.fetch()
		await reached(() => finishRecovery)
		await sync.save()
		finishRecovery(false)
		await fetching

		expect([...server.elements.keys()]).toEqual(['b'])
		expect(editor.elements.map((element) => element.id)).toEqual(['b'])
	})

	it('leaves the editor alone once the board is closed', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.write([box('a', 2)], {})
		let release = null
		server.hold = new Promise((resolve) => {
			release = resolve
		})

		const fetching = sync.fetch()
		sync.close()
		const updates = editor.updates
		release()
		await fetching

		expect(editor.updates).toBe(updates)
		expect(editor.elements[0].version).toBe(1)
	})

	it('opens the copy on this device when Nextcloud cannot be reached, and saves the edits made meanwhile', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const earlier = setup({ server })
		earlier.editor.elements = (await earlier.sync.open()).elements
		earlier.editor.appState = { viewBackgroundColor: '#123456' }
		earlier.sync.close()

		const { sync, editor } = setup({ server, scene: await earlier.store.cachedScene() })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		const data = await sync.open()
		expect(data.elements.map((element) => element.id)).toEqual(['a'])
		expect(data.appState.viewBackgroundColor).toBe('#123456')
		editor.elements = data.elements
		editor.edit(box('b', 1))
		sync.changed()
		await settle()

		server.request = request
		await advance(20_000)
		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
		expect(sent(server).flat()).toEqual(['b@1'])
		// The first tab's last change, sent again once Nextcloud could be reached
		expect(server.settings.viewBackgroundColor).toBe('#123456')
	})

	it('keeps new elements drawn on a board that did not load, and saves them with the stored board once it does', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, recoverable } = setup({ server })
		const request = server.request
		server.request = async () => ({ status: 503, body: null })
		expect(await sync.open()).toBeNull()
		editor.edit(box('b', 1))
		sync.changed()
		await settle()

		server.request = request
		await advance(20_000)
		expect(editor.elements.map((element) => element.id).sort()).toEqual(['a', 'b'])
		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
		expect(recoverable).not.toHaveBeenCalled()
	})

	it('shows a stored copy with the same stamp but other content once you stop editing it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { editingTextElement: { id: 'a' } }
		server.rev += 1
		server.elements.set('a', box('a', 1, 1, { x: 50 }))
		server.revs.set('a', server.rev)

		await sync.fetch()
		expect(editor.elements[0].x).toBeUndefined()

		editor.appState = {}
		sync.changed()
		await settle()
		expect(editor.elements[0].x).toBe(50)
	})

	it('adds recovered elements back as new edits', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 5)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements

		await sync.addRecovered({ elements: [box('a', 2, 2, { width: 50 })], files: {} })
		// Kept as unsaved before the recovery store lets go of them
		expect((await rowsOf(store)).outbox.map((entry) => `${entry.element.id}@${entry.element.version}`)).toEqual(['a@6'])

		expect(editor.elements).toHaveLength(1)
		expect(editor.elements[0].width).toBe(50)
		expect(editor.elements[0].version).toBe(6)
	})

	it('adds back a recovered image whose element Nextcloud already has', async () => {
		const server = fakeNextcloud()
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements

		await sync.addRecovered({ elements: [], files: { img: { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' } } })
		sync.changed()
		await settle()

		expect(Object.keys(server.files)).toEqual(['img'])
	})

	it('does not go back to a restore it heard of when a later one arrived first', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, announced } = setup({ server })
		editor.elements = (await sync.open()).elements
		// Nextcloud restored a version; the load of it answers late
		server.replace([box('mine', 1)], 'e2')
		const respond = server.request
		let release = null
		const late = new Promise((resolve) => {
			release = resolve
		})
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'GET' && !options?.query) {
				await late
			}
			return answer
		}

		const restoring = sync.restored()
		await Promise.resolve()
		// Someone else restored another version after it, and this tab loaded that one
		server.replace([box('theirs', 1)], 'e3')
		server.request = respond
		await sync.fetch()
		release()
		await restoring

		expect(editor.elements.map((element) => element.id)).toEqual(['theirs'])
		expect(announced.at(-1)).toMatchObject({ type: 'restored', epoch: 'e3' })
	})

	it('keeps an unsaved edit of the old epoch when the board is replaced before IndexedDB prunes', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		// Another tab of this browser kept an edit and closed before saving it
		await store.keep(server.epoch, { elements: [box('a', 5)], files: {} })
		// IndexedDB runs transactions in the order they were made, and this prune is slow
		let releasePrune = null
		const pruneGate = new Promise((resolve) => {
			releasePrune = resolve
		})
		const { dropSaved: prune, setAside: recover } = store
		let pruned = null
		store.dropSaved = (...args) => {
			pruned = pruneGate.then(() => prune(...args))
			return pruned
		}
		store.setAside = async (...args) => {
			await pruned
			return recover(...args)
		}

		const fetching = sync.fetch()
		await Promise.resolve()
		server.replace([box('a', 10)], 'e2')
		const restoring = sync.restored()
		await Promise.resolve()
		releasePrune()
		await Promise.all([fetching, restoring])

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`)).toEqual(['a@5'])
	})

	it('does not add recovered changes to a board that was closed meanwhile', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		sync.close()

		expect(await sync.addRecovered({ elements: [box('a', 2)], files: {} })).toBe(false)
	})

	it('adds a recovered element back at its place in the stack', async () => {
		const server = fakeNextcloud()
		server.write([box('b', 1, 1, { index: 'a1' })], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements

		await sync.addRecovered({ elements: [box('a', 3, 3, { index: 'a0' })], files: {} })

		expect(editor.elements.map((element) => element.id)).toEqual(['a', 'b'])
	})

	it('does not go back to a board it loaded late when it has a later one', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.replace([box('second', 1)])
		// The answer to the full load is late
		const respond = server.request
		let release = null
		const late = new Promise((resolve) => {
			release = resolve
		})
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'GET' && !options?.query) {
				await late
			}
			return answer
		}
		editor.edit(box('x', 1))
		sync.changed()
		await settle()

		// Another tab restored a later version, and this tab fetched it
		server.replace([box('third', 1)], 'e3')
		await sync.fetch()
		release()
		await advance(1000)

		expect(editor.elements.map((element) => element.id)).toEqual(['third'])
	})

	it('keeps the unsaved changes of a replaced board in memory until IndexedDB takes them', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store, recoverable } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { setAside: recover } = store
		let failures = 2
		store.setAside = async (...args) => {
			if (failures-- > 0) {
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		// Drawn just before the board is replaced, before it was kept
		editor.edit(box('x', 1))
		server.replace([box('b', 1)])

		await sync.fetch()
		await advance(10_000)

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
		expect(recoverable).toHaveBeenCalledWith(false)
	})

	it('keeps the images of unsaved image elements for recovery, even when Nextcloud had them', async () => {
		const server = fakeNextcloud()
		const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], { img: image })
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.files.img = image
		editor.edit(box('i', 2, 2, { type: 'image', fileId: 'img' }))
		// A version without the image is restored
		server.replace([box('b', 1)])

		await sync.fetch()

		expect(Object.keys((await rowsOf(store)).recovery[0].files)).toEqual(['img'])
	})

	it('sends what this device kept for the board once Nextcloud answers, after opening without it', async () => {
		const server = fakeNextcloud()
		server.write([box('stored', 1)], {})
		const { sync, editor, store } = setup({ server })
		// Kept by an earlier visit that could not save it
		await store.keep(server.epoch, { elements: [box('draft', 1)], files: {} })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		expect(await sync.open()).toBeNull()

		server.request = request
		await advance(75_000)
		await settle()
		expect(editor.elements.map((element) => element.id).sort()).toEqual(['draft', 'stored'])
		sync.changed()
		await advance(15_000)

		expect([...server.elements.keys()].sort()).toEqual(['draft', 'stored'])
	})

	it('reopens offline with the stored copy it had not shown yet, and shows it once you stop editing', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const earlier = setup({ server })
		earlier.editor.elements = (await earlier.sync.open()).elements
		earlier.editor.appState = { editingTextElement: { id: 'a' } }
		server.rev += 1
		server.elements.set('a', box('a', 1, 1, { x: 50 }))
		server.revs.set('a', server.rev)
		await earlier.sync.fetch()
		earlier.sync.close()

		const { sync, editor } = setup({ server, scene: await earlier.store.cachedScene() })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		editor.elements = (await sync.open()).elements
		server.request = request
		sync.changed()
		await settle()

		expect(editor.elements[0].x).toBe(50)
	})

	it('keeps the last settings change on this device, also when the page closes', async () => {
		const server = fakeNextcloud()
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 1))
		sync.changed()
		await settle()
		editor.appState = { viewBackgroundColor: '#222222' }
		sync.changed()
		await settle()
		expect((await store.cachedScene()).appState.viewBackgroundColor).toBeUndefined()

		await advance(10_000)
		expect((await store.cachedScene()).appState.viewBackgroundColor).toBe('#222222')

		editor.appState = { viewBackgroundColor: '#333333' }
		sync.flush()
		expect((await store.cachedScene()).appState.viewBackgroundColor).toBe('#333333')
	})

	it('does not take back a saved edit when a full load of the same board answers late', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		const respond = server.request
		const gate = () => {
			let open = null
			const promise = new Promise((resolve) => {
				open = resolve
			})
			return { promise, open }
		}
		const reload = gate()
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'GET' && !options?.query) {
				await reload.promise
			}
			return answer
		}
		// A restore this tab heard of: a poll loads it first, and the load for the restore answers late
		server.replace([box('a', 1)], 'e2')
		const restoring = sync.restored()
		await Promise.resolve()
		await sync.fetch()
		for (let i = 0; i < 10; i++) {
			await Promise.resolve()
		}
		editor.edit(box('x', 1))
		sync.changed()
		await settle()
		await sync.save()
		expect([...server.elements.keys()].sort()).toEqual(['a', 'x'])

		reload.open()
		await restoring
		await settle()

		expect(editor.elements.map((element) => element.id).sort()).toEqual(['a', 'x'])
		expect((await rowsOf(store)).recovery).toEqual([])
	})

	it('saves an image this device kept for the board once Nextcloud answers, after opening without it', async () => {
		const server = fakeNextcloud()
		const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], {})
		const { sync, store } = setup({ server })
		await store.keep(server.epoch, { elements: [], files: { [image.id]: image } })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		await sync.open()

		server.request = request
		await advance(75_000)
		await advance(15_000)

		expect(Object.keys(server.files)).toEqual(['img'])
	})

	it('moves only changes of other boards than the shown one to recovery when IndexedDB recovers late', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { setAside: recover } = store
		let failures = 1
		store.setAside = async (...args) => {
			if (failures-- > 0) {
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		editor.edit(box('x', 1))
		server.replace([box('b', 1)], 'e2')
		await sync.fetch()
		server.replace([box('c', 1)], 'e3')
		await sync.fetch()
		// Drawn on the board shown now and kept, before the first recovery is tried again
		editor.edit(box('y', 1))
		sync.changed()
		await settle()

		await advance(5_000)

		expect((await rowsOf(store)).outbox.map((entry) => `${entry.epoch}:${entry.element.id}`)).toEqual(['e3:y'])
	})

	it('opens the restored board when Nextcloud answers with it while the copy on this device is still opening', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const earlier = setup({ server })
		earlier.editor.elements = (await earlier.sync.open()).elements
		earlier.sync.close()
		server.replace([box('restored', 1)])

		const { sync, store } = setup({ server, scene: await earlier.store.cachedScene(), editor: null })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		const { claimKept: kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.claimKept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		await reached(() => keeping)
		server.request = request
		store.claimKept = kept
		await sync.fetch()
		releaseKept()

		expect((await opening).elements.map((element) => element.id)).toEqual(['restored'])
	})

	it('tries again to keep a replaced board\'s changes for recovery when the page closes', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { setAside: recover } = store
		let failures = 1
		store.setAside = async (...args) => {
			if (failures-- > 0) {
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		editor.edit(box('x', 1))
		server.replace([box('b', 1)])
		await sync.fetch()

		sync.close()
		await settle()

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
	})

	it('sends an edit made just before the board closed, after the editor is gone', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		let shown = fakeEditor()
		const { sync } = setup({ server, editor: null })
		const editor = shown
		sync.options.editor = () => shown
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		// The viewer closes: the editor goes first, then the board
		shown = null
		sync.close()
		await settle()

		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
	})

	it('keeps trying to keep a replaced board\'s changes for recovery after the board closed', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { setAside: recover } = store
		let release = null
		const slow = new Promise((resolve) => {
			release = resolve
		})
		let calls = 0
		store.setAside = async (...args) => {
			if (calls++ === 0) {
				await slow
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		editor.edit(box('x', 1))
		server.replace([box('b', 1)])
		const fetching = sync.fetch()
		await reached(() => calls > 0)
		// Another board opens while IndexedDB is still busy with the first try
		sync.close()
		release()
		await fetching
		await advance(5_000)

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
	})

	it('opens with what this device kept for the board that overtook the open', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		server.replace([box('new', 1)], 'e2')
		// Kept by another tab of this browser that already had the new board
		await store.keep('e2', { elements: [box('draft', 1)], files: {} })
		const { claimKept: kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.claimKept = async (...args) => {
			if (!keeping) {
				keeping = true
				await keptGate
			}
			return kept(...args)
		}
		const respond = server.request
		let firstGet = true
		server.request = async (method, options) => {
			if (firstGet && method === 'GET') {
				firstGet = false
				// The open's load still sees the old board
				return { status: 200, body: { sync: { epoch: 'e1', rev: 1 }, data: { elements: [box('old', 1)], files: {} } } }
			}
			return respond(method, options)
		}
		const opening = sync.open()
		await reached(() => keeping)
		await sync.fetch()
		releaseKept()

		expect((await opening).elements.map((element) => element.id).sort()).toEqual(['draft', 'new'])
	})

	it('keeps the edits it sends when the board closes, in case that request fails', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		let shown = fakeEditor()
		const { sync, store } = setup({ server, editor: null })
		const editor = shown
		sync.options.editor = () => shown
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		server.request = async () => {
			throw new Error('offline')
		}
		// The editor goes first, then the board closes
		shown = null
		sync.close()
		await settle()

		expect((await rowsOf(store)).outbox.map((entry) => entry.element.id)).toEqual(['b'])
	})

	it('opens with what Nextcloud saved while the board was opening', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { claimKept: kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.claimKept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		await reached(() => keeping)
		server.write([box('b', 1)], {})
		await sync.fetch()
		releaseKept()

		expect((await opening).elements.map((element) => element.id).sort()).toEqual(['a', 'b'])
	})

	it('keeps trying to keep the last changes of a closed board when IndexedDB fails once', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		let shown = fakeEditor()
		const { sync, store } = setup({ server, editor: null })
		const editor = shown
		sync.options.editor = () => shown
		editor.elements = (await sync.open()).elements
		editor.edit(box('x', 1))
		sync.changed()
		server.request = async () => {
			throw new Error('offline')
		}
		const { keep } = store
		let failures = 1
		store.keep = async (...args) => {
			if (failures-- > 0) {
				throw new Error('AbortError')
			}
			return keep(...args)
		}
		shown = null
		sync.close()
		await advance(5_000)

		expect((await rowsOf(store)).outbox.map((entry) => entry.element.id)).toEqual(['x'])
	})

	it('opens with the images of what Nextcloud saved while the board was opening', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { claimKept: kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.claimKept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		await reached(() => keeping)
		const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], { img: image })
		await sync.fetch()
		releaseKept()

		expect(Object.keys((await opening).files)).toEqual(['img'])
	})

	it('leaves the kept changes of a newer board alone when a closed board retries its recovery', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { setAside: recover } = store
		let failures = 1
		store.setAside = async (...args) => {
			if (failures-- > 0) {
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		editor.edit(box('x', 1))
		server.replace([box('b', 1)], 'e2')
		await sync.fetch()
		sync.close()
		// The board opened again elsewhere in this page, on a later epoch, and kept a change there
		await store.keep('e3', { elements: [box('y', 1)], files: {} })

		await advance(5_000)

		expect((await rowsOf(store)).outbox.map((entry) => `${entry.epoch}:${entry.element.id}`)).toEqual(['e3:y'])
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
	})

	it('opens the latest board when two others overtake the open one after the other', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { claimKept: kept } = store
		const gates = []
		store.claimKept = async (...args) => {
			await new Promise((resolve) => gates.push(resolve))
			return kept(...args)
		}
		const opening = sync.open()
		const waitForKept = (count) => reached(() => gates.length >= count)
		await waitForKept(1)
		server.replace([box('second', 1)], 'e2')
		await sync.fetch()
		gates[0]()
		await waitForKept(2)
		server.replace([box('third', 1)], 'e3')
		await sync.fetch()
		gates[1]()
		await waitForKept(3)
		gates[2]?.()

		expect((await opening).elements.map((element) => element.id)).toEqual(['third'])
	})

	it('shows the stored copies on a read-only tab together once the first one is past the grace period', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1, 1, { index: 'a0' }), box('b', 1, 1, { index: 'a1' })], {})
		const { sync, editor } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements
		// Copies this tab made itself when Excalidraw gave clashing elements new indices, at different times
		editor.edit(box('a', 2, 9, { index: 'a2' }))
		sync.changed()
		await advance(60_000)
		editor.edit(box('b', 2, 9, { index: 'a3' }))
		sync.changed()
		await advance(100_000)

		expect(editor.elements.map((element) => `${element.id}@${element.version}:${element.index}`)).toEqual(['a@1:a0', 'b@1:a1'])
	})

	it('keeps an edit on the device when the board is read-only for a moment as it closes', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		let readOnly = false
		sync.options.isReadOnly = () => readOnly
		editor.edit(box('b', 1))
		sync.changed()
		// The token is being refreshed: read-only until it is back
		readOnly = true

		sync.close()
		await settle()

		expect((await rowsOf(store)).outbox.map((entry) => entry.element.id)).toEqual(['b'])
		expect(sent(server)).toEqual([])
	})

	it('keeps the own edit of a tab that may save now, made just before a viewer clean-up was due', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, readOnly: true, leader: false })
		editor.elements = (await sync.open()).elements
		let readOnly = true
		sync.options.isReadOnly = () => readOnly
		// From a writer over the relay, never saved
		editor.edit(box('a', 2))
		sync.changed()
		await advance(115_000)
		// Edit rights arrive, and this tab edits the element
		readOnly = false
		editor.edit(box('a', 3))
		sync.changed()
		await advance(10_000)

		expect(editor.elements.find((element) => element.id === 'a').version).toBe(3)
		expect((await rowsOf(store)).outbox.map((entry) => `${entry.element.id}@${entry.element.version}`)).toContain('a@3')
	})

	it('opens with the images of the board that overtook the open, not those of the earlier one', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { claimKept: kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.claimKept = async (...args) => {
			if (!keeping) {
				keeping = true
				await keptGate
			}
			return kept(...args)
		}
		const opening = sync.open()
		await reached(() => keeping)
		const before = { id: 'img', dataURL: 'data:image/png;base64,OLD', mimeType: 'image/png' }
		const after = { id: 'img', dataURL: 'data:image/png;base64,NEW', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], { img: before })
		await sync.fetch()
		// The file is replaced; the new board has other bytes under the same image id
		server.replace([box('i', 1, 1, { type: 'image', fileId: 'img' })], 'e2', { files: { img: after } })
		await sync.fetch()
		releaseKept()

		expect((await opening).files.img.dataURL).toBe(after.dataURL)
	})

	it('ends a text edit in progress before the board is replaced, so the text goes to recovery and not into the new board', async () => {
		const server = fakeNextcloud()
		server.write([box('t', 1, 1, { type: 'text', text: 'saved' })], {})
		// Leaving the text field commits what was typed, as Excalidraw does
		const endEditing = vi.fn((shown) => {
			shown.edit(box('t', 2, 2, { type: 'text', text: 'typed before the restore' }))
			shown.appState = {}
		})
		const { sync, editor, store } = setup({ server, endEditing, leader: false })
		editor.elements = (await sync.open()).elements
		editor.appState = { editingTextElement: { id: 't' } }
		server.replace([box('t', 1, 1, { type: 'text', text: 'restored' })], 'e2')

		await sync.fetch()

		expect(endEditing).toHaveBeenCalled()
		expect(editor.elements.map((element) => element.text)).toEqual(['restored'])
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.text)).toEqual(['typed before the restore'])
	})

	it('keeps an edit that finished after its board was replaced for recovery', async () => {
		const server = fakeNextcloud()
		const { sync, editor, store, recoverable } = setup({ server })
		editor.elements = (await sync.open()).elements
		const image = { id: 'table-image', dataURL: 'data:image/svg+xml;base64,AAAA', mimeType: 'image/svg+xml' }

		sync.setAsideForRecovery({ elements: [box('table', 2, 7, { type: 'image', fileId: 'table-image' })], files: { 'table-image': image } })
		await settle()

		expect((await rowsOf(store)).recovery[0].elements.map((element) => element.id)).toEqual(['table'])
		expect(Object.keys((await rowsOf(store)).recovery[0].files)).toEqual(['table-image'])
		expect(recoverable).toHaveBeenCalledWith(false)
	})

	it('catches up again after a request that stalled and was aborted', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const respond = server.request
		let hung = true
		// The request layer aborts a request that receives nothing for a minute
		server.request = (method, options) => hung && method === 'GET' ? new Promise((resolve, reject) => setTimeout(() => reject(new Error('aborted')), 60_000)) : respond(method, options)
		const first = sync.fetch()
		hung = false
		server.replace([box('new', 1)], 'e2')
		sync.hint({ epoch: 'e2', rev: server.rev })

		await advance(65_000)
		await first.catch(() => {})
		await advance(5_000)

		expect(editor.elements.map((element) => element.id)).toEqual(['new'])
	})

	it('saves images the server lacks with the elements that use them', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.files.img = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
		editor.edit(box('i', 1, 1, { type: 'image', fileId: 'img' }))

		sync.changed()
		await settle()

		expect(Object.keys(server.files)).toEqual(['img'])
		sync.changed()
		await advance(15_000)
		expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
	})

	it('offers only the draft elements of the previous client that win over the stored copy', async () => {
		const server = fakeNextcloud()
		// Saved after the 2.x session: the ellipse moved (v8, x 600), the text deleted (v3)
		server.write([box('e', 8, 8, { type: 'ellipse', x: 600 }), box('t', 3, 3, { type: 'text', text: 'Bob 2x', isDeleted: true }), box('r', 2, 2, { x: 0 }), box('n', 1, 1, { x: 1 })], {})
		// The 2.x tab kept its whole scene as pending: older ellipse and text, the rectangle as stored, and an edit of n it never saved
		const legacy = { elements: [box('e', 6, 6, { type: 'ellipse', x: 300 }), box('t', 2, 2, { type: 'text', text: 'Bob 2x' }), box('r', 2, 2, { x: 0 }), box('n', 2, 2, { x: 70 })], files: {} }
		const { sync, editor, store, recoverable } = setup({ server, legacy })

		editor.elements = (await sync.open()).elements
		expect(recoverable).toHaveBeenCalledWith(true)
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toEqual(['n'])
		await sync.addRecovered({ elements: (await rowsOf(store)).recovery.flatMap((entry) => entry.elements), files: {} })
		sync.changed()
		await settle()
		await advance(11_000)

		const stored = Object.fromEntries([...server.elements.values()].map((element) => [element.id, element]))
		expect({ ellipseX: stored.e.x, textDeleted: stored.t.isDeleted, rectangle: stored.r.version, n: stored.n.x }).toEqual({ ellipseX: 600, textDeleted: true, rectangle: 2, n: 70 })
	})

	it('drops a draft of the previous client without a notice when Nextcloud has all of it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 4, 4, { x: 9 }), box('img', 2, 2, { type: 'image', fileId: 'f1' })], { f1: { id: 'f1', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' } })
		const dropLegacy = vi.fn(async () => {})
		const legacy = { elements: [box('a', 3, 3, { x: 1 }), box('img', 2, 2, { type: 'image', fileId: 'f1' })], files: { f1: { id: 'f1', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' } } }
		const { sync, store, recoverable } = setup({ server, legacy, dropLegacy })

		await sync.open()

		expect(recoverable).not.toHaveBeenCalled()
		expect((await rowsOf(store)).recovery).toEqual([])
		expect(dropLegacy).toHaveBeenCalled()
	})

	it('adds back only recovered elements that change the board', async () => {
		const server = fakeNextcloud()
		server.write([box('same', 5, 5, { x: 1 }), box('moved', 5, 5, { x: 1 })], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements

		await sync.addRecovered({ elements: [box('same', 2, 2, { x: 1 }), box('moved', 2, 2, { x: 80 })], files: {} })

		const byId = Object.fromEntries(editor.elements.map((element) => [element.id, element]))
		expect({ same: byId.same.version, moved: byId.moved.version, x: byId.moved.x }).toEqual({ same: 5, moved: 6, x: 80 })
	})

	it('adds back what the device kept for recovery, and only then lets it go', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		await store.keep('old', { elements: [box('r', 1, 1, { x: 50 })], files: {} })
		editor.elements = (await sync.open()).elements
		expect((await rowsOf(store)).recovery).toHaveLength(1)

		expect(await sync.addBack()).toBe(true)

		expect(editor.elements.find((element) => element.id === 'r')?.x).toBe(50)
		expect((await rowsOf(store)).recovery).toEqual([])
		expect((await rowsOf(store)).outbox.map((row) => row.element?.id)).toContain('r')
	})

	it('adds kept changes back as the newest copy of what the board shows when they land', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1, 1, { x: 0 })], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		const keep = store.keep
		let kept = null
		store.keep = (epoch, changes) => new Promise((resolve) => {
			kept = () => resolve(keep(epoch, changes))
		})

		const adding = sync.addRecovered({ elements: [box('a', 5, 5, { x: 50 })], files: {} })
		await reached(() => kept)
		// Another tab's later copy reaches the board while the device keeps the recovered one
		editor.edit(box('a', 9, 9, { x: 99 }))
		store.keep = keep
		kept()
		await adding

		const shown = editor.elements.find((element) => element.id === 'a')
		expect({ x: shown.x, newest: shown.version > 9 }).toEqual({ x: 50, newest: true })
	})

	it('keeps a recovered element the board already shows unsaved before letting the recovery go', async () => {
		const server = fakeNextcloud()
		server.write([box('r', 1, 1, { x: 0 })], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		// The board shows the recovered content as an unsaved edit the full device could not keep
		editor.edit(box('r', 3, 3, { x: 50 }))
		store.keep = async (epoch, changes) => {
			if (changes.elements.length > 0) {
				throw new Error('QuotaExceededError')
			}
		}

		await expect(sync.addRecovered({ elements: [box('r', 2, 2, { x: 50 })], files: {} })).rejects.toThrow('QuotaExceededError')
	})

	it('shows nothing of the kept changes while the device cannot keep them', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		store.keep = async () => {
			throw new Error('QuotaExceededError')
		}

		await expect(sync.addRecovered({ elements: [box('r', 1, 1, { x: 50 })], files: {} })).rejects.toThrow('QuotaExceededError')

		expect(editor.elements.map((element) => element.id)).toEqual(['a'])
	})

	it('keeps recovered elements on the device when adding them back again after the device was full', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.answerPuts({ status: answers.busy.status, body: { code: answers.busy.code } })
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		const updateScene = editor.updateScene
		editor.updateScene = (update) => {
			updateScene(update)
			sync.changed()
		}
		const keep = store.keep
		let full = true
		store.keep = async (epoch, changes) => {
			if (full && changes.elements.length > 0) {
				throw new Error('QuotaExceededError')
			}
			return keep(epoch, changes)
		}
		const recovered = { elements: [box('r', 1, 1, { x: 50 })], files: {} }

		// The first try cannot keep it and shows nothing; the notice is offered again
		await expect(sync.addRecovered(recovered)).rejects.toThrow('QuotaExceededError')
		await settle()
		full = false
		expect(await sync.addRecovered(recovered)).toBe(true)
		await idle()

		expect((await rowsOf(store)).outbox.map((row) => row.element?.id)).toContain('r')
	})

	it('does not offer changes a closing board saved as unsaved after a restore', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1, 1, { x: 0 })], {})
		const first = setup({ server })
		first.editor.elements = (await first.sync.open()).elements
		first.editor.edit(box('a', 2, 2, { x: 500 }))
		first.sync.changed()
		first.sync.close()
		await advance(3_000)
		expect(server.elements.get('a').x).toBe(500)
		server.replace([box('a', 1, 1, { x: 0 })])

		const second = new BoardSync({ ...first.sync.options })
		await second.open()

		expect((await rowsOf(first.store)).recovery).toEqual([])
		expect(first.recoverable).not.toHaveBeenCalled()
	})

	it('does not offer changes a closing page saved with keepalive as unsaved after a restore', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1, 1, { x: 0 })], {})
		const first = setup({ server })
		first.editor.elements = (await first.sync.open()).elements
		first.editor.edit(box('a', 2, 2, { x: 500 }))
		first.sync.changed()
		first.sync.flush()
		await advance(100)
		expect(server.elements.get('a').x).toBe(500)
		first.sync.close()
		await advance(3_000)
		server.replace([box('a', 1, 1, { x: 0 })])

		const second = new BoardSync({ ...first.sync.options })
		await second.open()

		expect((await rowsOf(first.store)).recovery).toEqual([])
	})

	it('keeps the changes of a closing board when its last save fails', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1, 1, { x: 0 })], {})
		const first = setup({ server })
		first.editor.elements = (await first.sync.open()).elements
		first.editor.edit(box('a', 2, 2, { x: 500 }))
		first.sync.changed()
		const respond = server.request
		server.request = async (method, options) => method === 'PUT' ? { status: 503, body: { code: 'busy' } } : respond(method, options)
		first.sync.close()
		await advance(3_000)

		expect((await rowsOf(first.store)).outbox.map((entry) => `${entry.element.id}@${entry.element.version}`)).toEqual(['a@2'])
	})

	it('keeps unsaved changes as unsaved when the new epoch reverts nothing', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('b', 1)], {})
		const { sync, editor, store, recoverable } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 2, 2, { x: 40 }))
		// The same file saved under another file id: everything there, b moved on, c added, as a new epoch here
		server.replace([box('a', 1), box('b', 3), box('c', 1)], 'e2')

		await sync.fetch()
		await sync.save()

		expect(editor.elements.map((element) => `${element.id}@${element.version}`).sort()).toEqual(['a@2', 'b@3', 'c@1'])
		expect(server.elements.get('a').x).toBe(40)
		expect((await rowsOf(store)).recovery).toEqual([])
		expect(recoverable).not.toHaveBeenCalled()
	})

	it('sends unsaved changes to recovery when the new epoch takes an element back', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 3), box('b', 3)], {})
		const { sync, editor, store, recoverable } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 4, 4, { x: 40 }))
		// A version restore: b goes back to an older copy
		server.replace([box('a', 3), box('b', 2)], 'e2')

		await sync.fetch()

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`)).toEqual(['a@4'])
		expect(recoverable).toHaveBeenCalled()
		expect(editor.elements.map((element) => `${element.id}@${element.version}`).sort()).toEqual(['a@3', 'b@2'])
	})

	it('keeps nothing for recovery in a tab that only ever showed the board', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store, recoverable } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements
		// A writer's edit arrived over the socket and is not saved yet
		editor.edit(box('a', 2, 2, { x: 9 }))
		server.replace([box('v', 1)], 'e2')

		await sync.fetch()

		expect((await rowsOf(store)).recovery).toEqual([])
		expect(recoverable).not.toHaveBeenCalled()
		expect(editor.elements.map((element) => element.id)).toEqual(['v'])
	})

	it('shows a new epoch as Nextcloud has it in a tab that only ever showed the board, without what a writer of this browser kept', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements
		server.replace([box('v', 1)], 'e2')
		// A tab of this browser that can save kept an edit of the new epoch
		await store.keep('e2', { elements: [box('w', 1)], files: {} })

		await sync.fetch()
		await settle()

		expect(editor.elements.map((element) => element.id)).toEqual(['v'])
	})

	it('does not offer the draft of the previous client in a tab that cannot save', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const dropLegacy = vi.fn(async () => {})
		const { sync, store, recoverable } = setup({ server, readOnly: true, legacy: { elements: [box('a', 5, 5, { x: 3 })], files: {} }, dropLegacy })

		await sync.open()

		expect((await rowsOf(store)).recovery).toEqual([])
		expect(recoverable).not.toHaveBeenCalled()
		expect(dropLegacy).not.toHaveBeenCalled()
	})

	it('does not add recovered changes in a tab that cannot save', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements

		expect(await sync.addRecovered({ elements: [box('a', 3, 3, { x: 4 })], files: {} })).toBe(false)
		expect(editor.elements[0].version).toBe(1)
	})

	it('keeps nothing on the device in a tab that only ever showed the board when the new epoch takes nothing back', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, readOnly: true })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 2, 2, { x: 9 }))
		server.replace([box('a', 1), box('b', 1)], 'e2')

		await sync.fetch()
		await settle()

		expect((await rowsOf(store)).outbox).toEqual([])
		expect((await rowsOf(store)).recovery).toEqual([])
	})

	it('waits for a board that takes longer than a minute to download', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync } = setup({ server })
		const respond = server.request
		server.request = async (method, options) => {
			await new Promise((resolve) => setTimeout(resolve, 90_000))
			return respond(method, options)
		}

		const opened = sync.open()
		await advance(91_000)

		expect((await opened).elements.map((element) => element.id)).toEqual(['a'])
	})

	it('tries a save again when its answer is not one of the board API, for example a login page of a proxy', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, statuses } = setup({ server })
		editor.elements = (await sync.open()).elements
		// A proxy's login page
		server.answerPuts({ status: 200, body: null }, 1)

		editor.edit(box('b', 1))
		sync.changed()
		await advance(10_300)
		expect(statuses.some((status) => status.failed)).toBe(true)
		await advance(5_000)

		expect(server.elements.get('b')?.version).toBe(1)
		expect(sync.status).toMatchObject({ failed: false, unsavedSince: null })
	})

	it.each([
		['the board is gone', answers.gone.status, { message: 'File not found' }, 'gone'],
		['the tab may no longer change it', answers.forbidden.status, { message: 'Permission denied' }, 'forbidden'],
		['the client is too old for it', answers.upgrade.status, { status: 'error', code: answers.upgrade.code }, 'upgrade'],
	])('stops sending a save Nextcloud refused because %s, and says it did not reach Nextcloud and why', async (_, status, body, reason) => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.answerPuts({ status, body })

		editor.edit(box('b', 1))
		sync.changed()
		await advance(5 * 60_000)

		expect(sent(server)).toHaveLength(1)
		expect(sync.status).toMatchObject({ failed: true, reason })
		expect(sync.hasUnsavedChanges()).toBe(true)
	})

	it.each([
		['the session ended', 401, { message: 'Unauthorized' }, 'unauthorized'],
		['the changes are too large for the web server', 413, null, 'tooLarge'],
	])('tries a save again that did not reach Nextcloud because %s, and says why until it does', async (_, status, body, reason) => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, statuses } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.answerPuts({ status, body }, 1)

		editor.edit(box('b', 1))
		sync.changed()
		await advance(10_300)
		expect(statuses).toContainEqual(expect.objectContaining({ failed: true, reason }))
		await advance(5_000)

		expect(server.elements.get('b')?.version).toBe(1)
		expect(sync.status).toMatchObject({ failed: false, reason: null, unsavedSince: null })
	})

	it('stops loading a replaced board again once Nextcloud refuses it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const request = server.request
		let refused = 0
		server.request = async (method, options) => {
			if (method === 'GET' && !options?.query) {
				refused++
				return { status: answers.forbidden.status, body: { message: 'Permission denied' } }
			}
			return request(method, options)
		}

		// The board was replaced, and the tab may no longer read it
		server.replace([box('b', 1)], 'e2')
		editor.edit(box('c', 1))
		sync.changed()
		await advance(5 * 60_000)

		expect(refused).toBe(1)
	})

	it('stops sending the last changes of a closed board when Nextcloud asks for a newer client', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.answerPuts({ status: answers.upgrade.status, body: { status: 'error', code: answers.upgrade.code } })
		editor.edit(box('b', 1))
		sync.changed()

		sync.close()
		await advance(5 * 60_000)

		expect(sent(server)).toHaveLength(1)
	})

	it('tells when changes are waiting, being saved and saved', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, statuses } = setup({ server })
		editor.elements = (await sync.open()).elements
		expect(sync.status).toMatchObject({ unavailable: false, unsavedSince: null, saving: false, failed: false })

		editor.edit(box('a', 2))
		sync.changed()
		await advance(300)
		expect(sync.status.unsavedSince).toBeTypeOf('number')
		const respond = server.request
		let release = null
		server.request = async (method, options) => {
			if (method === 'PUT') {
				await new Promise((resolve) => {
					release = resolve
				})
			}
			return respond(method, options)
		}
		await advance(10_000)
		expect(sync.status.saving).toBe(true)
		release()
		await advance(10)

		expect(sync.status).toMatchObject({ unsavedSince: null, saving: false, failed: false })
		expect(sync.status.savedAt).toBeTypeOf('number')
		expect(statuses.at(-1)).toEqual(sync.status)
	})

	it('tells when a save did not reach Nextcloud, and keeps the time of the first unsaved change', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const respond = server.request
		server.request = async (method, options) => method === 'PUT' ? { status: 500, body: null } : respond(method, options)

		editor.edit(box('a', 2))
		sync.changed()
		await advance(300)
		const since = sync.status.unsavedSince
		await advance(11_000)
		editor.edit(box('a', 3))
		sync.changed()
		await advance(300)

		expect(sync.status).toMatchObject({ failed: true, saving: false, unsavedSince: since })
	})

	it('tells that the board is unavailable until Nextcloud gives it, when this device has no copy', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync } = setup({ server })
		const respond = server.request
		server.request = async () => ({ status: 401, body: null })

		expect(await sync.open()).toBeNull()
		expect(sync.status.unavailable).toBe(true)

		server.request = respond
		await advance(61_000)
		expect(sync.status.unavailable).toBe(false)
	})

	it('opens from the copy on this device without calling the board unavailable', async () => {
		const server = fakeNextcloud()
		server.request = async () => ({ status: 503, body: null })
		const { sync } = setup({ server, scene: { account: 'alice', fileId: 1, elements: [box('a', 1)], files: {}, cachedAt: 1, server: { epoch: 'e1', rev: 1, ids: ['a'], differing: [], files: [] } } })

		expect((await sync.open()).elements.map((element) => element.id)).toEqual(['a'])
		expect(sync.status.unavailable).toBe(false)
	})

	it('saves board settings such as the background', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ffffff' }

		editor.appState = { viewBackgroundColor: '#ffec99' }
		sync.changed()
		await settle()
		await advance(11_000)

		expect(server.settings).toEqual({ viewBackgroundColor: '#ffec99' })
		expect(server.requests.filter((request) => request.method === 'PUT').at(-1).body.data.settings).toEqual({ viewBackgroundColor: '#ffec99' })
		expect(sync.status.unsavedSince).toBeNull()
	})

	it('shows board settings another tab saved', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ffffff' }

		server.write([], {}, { viewBackgroundColor: '#a5d8ff' })
		await sync.fetch()

		expect(editor.appState.viewBackgroundColor).toBe('#a5d8ff')
		await advance(31_000)
		expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
	})

	it('keeps a background chosen here over one another tab saved meanwhile, as the later change', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ffffff' }
		editor.appState = { viewBackgroundColor: '#ffec99' }
		sync.changed()
		await settle()

		server.write([], {}, { viewBackgroundColor: '#a5d8ff' })
		await sync.fetch()
		await advance(31_000)

		expect(editor.appState.viewBackgroundColor).toBe('#ffec99')
		expect(server.settings.viewBackgroundColor).toBe('#ffec99')
	})

	it('keeps a background that is not saved yet on the device and shows it again', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffffff' })
		const first = setup({ server })
		first.editor.elements = (await first.sync.open()).elements
		first.editor.appState = { viewBackgroundColor: '#ffffff' }
		const respond = server.request
		server.request = async (method, options) => method === 'PUT' ? { status: 503, body: null } : respond(method, options)
		first.editor.appState = { viewBackgroundColor: '#ffec99' }
		first.sync.changed()
		await settle()
		first.sync.close()
		await advance(100)
		server.request = respond

		const second = new BoardSync({ ...first.sync.options })
		const data = await second.open()

		expect(data.appState.viewBackgroundColor).toBe('#ffec99')
	})

	it('sends the changes of a closing page with keepalive only when their bytes fit', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		// 25,000 characters of three bytes each: 25,000 UTF-16 units, 75,000 bytes
		editor.edit(box('t', 1, 1, { type: 'text', text: '漢'.repeat(25_000) }))
		sync.changed()

		expect(sync.flush()).toBe(false)
		expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
	})

	it('tells that the changes of a closing page went out with keepalive, and sends them once', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 1, 1, { x: 3 }))
		sync.changed()

		expect(sync.flush()).toBe(true)
		// The page hides right after it asked to unload
		expect(sync.flush()).toBe(true)
		await advance(10)

		expect(server.requests.filter((request) => request.method === 'PUT' && request.keepalive)).toHaveLength(1)
	})

	it('does not count on keepalive without a token it can send', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		sync.options.keepaliveReady = () => false
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 1, 1, { x: 3 }))
		sync.changed()

		expect(sync.flush()).toBe(false)
	})

	it('saves everything at once and tells whether Nextcloud has it all', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 1, 1, { x: 3 }))
		sync.changed()
		expect(sync.hasUnsavedChanges()).toBe(true)

		expect(await sync.saveNow()).toBe(true)
		expect(server.elements.get('a').x).toBe(3)
		expect(sync.hasUnsavedChanges()).toBe(false)

		const respond = server.request
		server.request = async (method, options) => method === 'PUT' ? { status: 503, body: null } : respond(method, options)
		editor.edit(box('a', 2, 2, { x: 4 }))
		sync.changed()
		expect(await sync.saveNow()).toBe(false)
	})

	it('stops showing an element the editor cannot show instead of trying on every change', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('future', 1, 1, { type: 'unknown-type' })], {})
		const { sync, editor } = setup({ server })
		// The editor drops elements of types it does not know
		editor.elements = (await sync.open()).elements.filter((element) => element.type !== 'unknown-type')

		for (let i = 0; i < 5; i++) {
			sync.changed()
			await settle()
		}

		expect(editor.updates).toBe(0)
	})

	it('keeps a newer copy another tab of this browser kept when its own older copy carries over', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('x', 3)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.edit(box('x', 4, 4, { y: 1 }))
		sync.changed()
		await settle()
		// Another tab of this browser moved x further and closed before saving
		await store.keep(server.epoch, { elements: [box('x', 5, 5, { y: 2 })], files: {} })
		server.replace([box('a', 1), box('x', 3), box('b', 1)], 'e2')

		await sync.fetch()

		const kept = [...(await rowsOf(store)).outbox, ...(await rowsOf(store)).recovery.flatMap((entry) => entry.elements.map((element) => ({ element })))]
			.flatMap((entry) => entry.element ?? []).map((element) => `${element.id}@${element.version}`)
		expect(editor.elements.find((element) => element.id === 'x').version).toBe(4)
		expect(kept).toContain('x@5')
	})

	it('sends an unsaved change to recovery when its element changed on the new board, even to a later version', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('x', 5, 5, { x: 100 })], {})
		const { sync, editor, store, recoverable } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.edit(box('x', 6, 6, { x: 120 }))
		sync.changed()
		await settle()
		// This tab missed a restore of x (back to x 0), after which someone moved x to a higher version
		server.replace([box('a', 1), box('x', 6, 9, { x: 10 })], 'e3')

		await sync.fetch()

		expect(editor.elements.find((element) => element.id === 'x').x).toBe(10)
		// From the outbox and from memory; the store merges copies of an element when they are added back
		expect([...new Set((await rowsOf(store)).recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`))]).toEqual(['x@6'])
		expect(recoverable).toHaveBeenCalled()
	})

	it('keeps a later copy another tab of this browser kept when a closing board prunes what it saved', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const first = setup({ server, leader: false })
		first.editor.elements = (await first.sync.open()).elements
		first.editor.edit(box('a', 2, 2, { x: 5 }))
		first.sync.changed()
		await settle()
		// Another tab of this browser kept a later copy and has not saved it yet
		await first.store.keep(server.epoch, { elements: [box('a', 3, 3, { x: 9 })], files: {} })

		first.sync.close()
		await advance(3_000)

		expect((await rowsOf(first.store)).outbox.flatMap((entry) => entry.element ?? []).map((element) => `${element.id}@${element.version}`)).toContain('a@3')
	})

	it('ignores board settings in an answer older than what the tab already has', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffffff' })
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ffffff' }
		server.write([], {}, { viewBackgroundColor: '#0000ff' })
		const respond = server.request
		let release = null
		const late = new Promise((resolve) => {
			release = resolve
		})
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'GET') {
				await late
			}
			return answer
		}
		// The poll with blue is late; meanwhile another tab saved red, and this tab's save brings it
		const polling = sync.fetch()
		server.write([], {}, { viewBackgroundColor: '#ff0000' })
		editor.edit(box('a', 2))
		await sync.save()
		release()
		await polling

		expect(editor.appState.viewBackgroundColor).toBe('#ff0000')
	})

	it('sends an unsaved board setting to recovery when the new board changed it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffffff' })
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#0000ff' }
		sync.changed()
		await settle()
		// A version restore that only changes the background
		server.replace([box('a', 1)], 'e2', { settings: { viewBackgroundColor: '#ffff00' } })

		await sync.fetch()

		expect(editor.appState.viewBackgroundColor).toBe('#ffff00')
		expect((await store.recovered()).settings).toEqual({ viewBackgroundColor: '#0000ff' })
	})

	it('adds back a recovered board setting as a new change', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffffff' })
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ffffff' }

		expect(await sync.addRecovered({ elements: [], files: {}, settings: { viewBackgroundColor: '#0000ff' } })).toBe(true)
		sync.changed()
		await settle()
		await advance(11_000)

		expect(editor.appState.viewBackgroundColor).toBe('#0000ff')
		expect(server.settings.viewBackgroundColor).toBe('#0000ff')
	})

	it('sends the changes of a closing page again when the earlier keepalive request failed', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('a', 1, 1, { x: 3 }))
		sync.changed()
		const respond = server.request
		let fail = true
		server.request = async (method, options) => {
			if (options?.keepalive && fail) {
				fail = false
				throw new Error('Failed to fetch')
			}
			return respond(method, options)
		}

		expect(sync.flush()).toBe(true)
		await advance(10)
		expect(sync.flush()).toBe(true)
		await advance(10)

		expect(server.requests.filter((request) => request.keepalive)).toHaveLength(1)
		expect(server.elements.get('a').x).toBe(3)
	})

	it('forgets a kept board setting once it is changed back to what Nextcloud has', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffffff' })
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		editor.appState = { viewBackgroundColor: '#ff0000' }
		sync.changed()
		await settle()
		editor.appState = { viewBackgroundColor: '#ffffff' }
		sync.changed()
		await settle()

		expect((await store.claimKept(server.epoch)).settings).toBeUndefined()
	})

	it('keeps sending the last changes of a closed board until Nextcloud has them, and counts them as unsaved meanwhile', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		server.failPuts = 1

		sync.close()
		await settle()

		expect(sent(server)).toEqual([['b@1']])
		expect(sync.hasUnsavedChanges()).toBe(true)
		expect(getLeavingBoards()).toContain(sync)
		await advance(5_000)
		expect(server.elements.has('b')).toBe(true)
		expect(sync.hasUnsavedChanges()).toBe(false)
		expect(getLeavingBoards()).not.toContain(sync)
	})

	it('stops sending the last changes of a closed board once the board is open again in the page, so they cannot take back a later setting', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const first = setup({ server })
		setBoardSync(first.sync)
		first.editor.elements = (await first.sync.open()).elements
		first.editor.appState = { viewBackgroundColor: '#ff0000' }
		first.sync.changed()
		server.failPuts = 1

		const second = setup({ server, store: first.store })
		setBoardSync(second.sync)
		await settle()
		const data = await second.sync.open()
		second.editor.elements = data.elements
		second.editor.appState = { ...data.appState, viewBackgroundColor: '#0000ff' }
		second.sync.changed()
		await advance(30_000)

		expect(server.settings.viewBackgroundColor).toBe('#0000ff')
		expect(getLeavingBoards()).not.toContain(first.sync)
		setBoardSync(null)
	})

	it('sends the last changes of a closed board at once when asked to, for a logout', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		server.failPuts = 1
		sync.close()
		await settle()

		const saved = sync.saveNow()
		await settle()

		expect(await saved).toBe(true)
		expect(server.elements.has('b')).toBe(true)
	})

	it('covers a board Nextcloud cannot read when this device has no copy of it, and saves nothing over it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.corrupt()
		const { sync, editor, statuses } = setup({ server })

		expect(await sync.open()).toBeNull()
		expect(statuses.at(-1).unavailable).toBe(true)
		editor.edit(box('b', 1))
		sync.changed()
		await advance(40_000)

		expect(server.requests.some((request) => request.body?.sync.repair)).toBe(false)
		// Nothing was written into the unreadable bytes
		expect(server.unreadable).toBe(true)
		expect(server.elements.size).toBe(0)
		expect(statuses.at(-1).unavailable).toBe(true)
	})

	it('sends unsaved changes to recovery after a version restore, also when the restore takes nothing back', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.failPuts = 1
		editor.edit(box('b', 1))
		sync.changed()
		await settle()

		// A version equal to the stored board is restored
		server.replace([box('a', 1)], 'e2')
		server.restoredEpochs.add('e2')
		await sync.fetch()
		await settle()

		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements.map((element) => element.id))).toContain('b')
		expect(editor.elements.map((element) => element.id)).toEqual(['a'])
	})

	it('carries nothing over an outside write that removed what a save still waiting for its answer stored', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		let release = null
		server.holdAnswers = new Promise((resolve) => {
			release = resolve
		})
		editor.edit(box('b', 1))
		sync.changed()
		await settle()
		expect(server.elements.has('b')).toBe(true)

		// The desktop client writes the board without b before the save's answer arrives
		server.replace([box('a', 1)], 'e2')
		server.holdAnswers = null
		await sync.fetch()
		release()
		await advance(40_000)

		expect(server.elements.has('b')).toBe(false)
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements.map((element) => element.id))).toContain('b')
	})

	it('notes one copy of an element however many saves of it could not be sent', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const request = server.request
		server.request = async (method, options) => {
			if (method === 'PUT') {
				throw new TypeError('Failed to fetch')
			}
			return request(method, options)
		}

		for (let version = 1; version <= 3; version++) {
			editor.edit(box('b', version))
			await sync.save()
			sync.flush()
			await idle()
		}

		const noted = [...sync.unanswered.values()].flatMap((save) => [...save.values()]).concat([...sync.maybeStored.values()])
		expect(noted.map((element) => `${element.id}@${element.version}`)).toEqual(['b@3'])
	})

	it('notes one copy of an element however many saves of it failed without an answer', async () => {
		const server = fakeNextcloud()
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements

		for (let version = 1; version <= 5; version++) {
			editor.edit(box('b', version))
			server.answerPuts({ status: 500, body: null }, 1)
			await sync.save()
		}

		const noted = [...sync.unanswered.values()].flatMap((save) => [...save.values()]).concat([...sync.maybeStored.values()])
		expect(noted.map((element) => `${element.id}@${element.version}`)).toEqual(['b@5'])
	})

	it.each([
		['refused', answers.forbidden.status, { message: 'Permission denied' }],
		['busy', answers.busy.status, { code: answers.busy.code }],
	])('carries nothing over an outside write that removed what a save stored when the same copy sent again was %s', async (_, status, body) => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		let release = null
		server.holdAnswers = new Promise((resolve) => {
			release = resolve
		})
		editor.edit(box('b', 1))
		sync.changed()
		await settle()
		expect(server.elements.has('b')).toBe(true)

		// The page sends the same copy again as it unloads, and that answer comes first
		server.answerPuts({ status, body }, 1)
		sync.flush()
		await idle()
		server.replace([box('a', 1)], 'e2')
		server.holdAnswers = null
		await sync.fetch()
		release()
		await advance(40_000)

		expect(server.elements.has('b')).toBe(false)
		expect((await rowsOf(store)).recovery.flatMap((entry) => entry.elements.map((element) => element.id))).toContain('b')
	})

	it('keeps a board Nextcloud cannot read covered while it asks again, without a moment uncovered', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.corrupt()
		const { sync, statuses } = setup({ server })
		expect(await sync.open()).toBeNull()
		const seen = statuses.length

		await sync.fetch()

		expect(statuses.slice(seen).map((status) => status.unavailable)).not.toContain(false)
	})

	it('lifts the cover once another tab repaired the board in the same epoch', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.corrupt()
		const { sync, editor, statuses } = setup({ server })
		expect(await sync.open()).toBeNull()

		// A tab with a copy of the board saved it over the unreadable bytes
		server.unreadable = false
		server.write([box('b', 1)], {})
		await sync.fetch()

		expect(statuses.at(-1).unavailable).toBe(false)
		expect(editor.elements.map((element) => element.id)).toContain('b')
	})

	it('counts a change that keeps going as unsaved since the last save that landed, so a tab that does not lead saves no more often', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, statuses } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		server.delay = 500
		const start = Date.now()

		for (let version = 2; version < 352; version++) {
			editor.edit(box('a', version))
			sync.changed()
			await advance(200)
		}

		expect(sent(server).length).toBeLessThanOrEqual(3)
		expect(statuses.at(-1).unsavedSince).toBeGreaterThanOrEqual(start + 55_000)
	})

	it('shows the settings of a restored board that sets none, and saves none of the earlier ones back', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {}, { viewBackgroundColor: '#ffec99' })
		const { sync, editor } = setup({ server })
		const data = await sync.open()
		editor.elements = data.elements
		editor.appState = { ...data.appState }
		server.replace([box('a', 1)], 'e2')

		await sync.restored()
		await advance(15_000)

		expect(editor.appState.viewBackgroundColor).toBe('#ffffff')
		expect(server.requests.filter((request) => request.method === 'PUT')).toEqual([])
	})

	it('counts unsaved changes while the tab may not save for a while, so a logout asks first', async () => {
		let readOnly = false
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server, readOnly: () => readOnly })
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()

		readOnly = true

		expect(sync.hasUnsavedChanges()).toBe(true)
		expect(await sync.saveNow()).toBe(false)
	})

	it('tells whether this device keeps changes Nextcloud does not have, also those set aside for recovery', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		expect(await sync.hasUnsavedOnDevice()).toBe(false)
		server.failPuts = 1
		editor.edit(box('a', 2))
		sync.changed()
		await settle()

		server.replace([box('a', 1, 9)], 'e2')
		await sync.restored()
		await settle()

		expect((await store.recovered()).elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@2'])
		expect(sync.hasUnsavedChanges()).toBe(false)
		expect(await sync.hasUnsavedOnDevice()).toBe(true)
	})

	it('clears a failed save once Nextcloud has the change another way', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, statuses } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		server.failPuts = 1
		await settle()
		expect(statuses.at(-1).failed).toBe(true)

		// Another tab saved the same change
		server.write([box('b', 1)], {})
		await sync.fetch()
		await advance(5_000)

		expect(statuses.at(-1).failed).toBe(false)
	})

	it('reports a save Nextcloud stored as saved when the device copy cannot be cleaned up', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store, statuses, announced } = setup({ server })
		editor.elements = (await sync.open()).elements
		store.dropSaved = async () => {
			throw new Error('Connection to Indexed Database server lost')
		}
		store.keep = async () => {
			throw new Error('Connection to Indexed Database server lost')
		}
		editor.edit(box('b', 1))
		sync.changed()

		await advance(11_000)

		expect(server.elements.has('b')).toBe(true)
		expect(statuses.at(-1).failed).toBe(false)
		expect(announced.some((notice) => notice.type === 'saved')).toBe(true)
	})

	it('keeps the text being edited, the undo history and the view when a new epoch is a later state of the same board', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1), box('t', 1, 1, { type: 'text', text: 'Hel' })], {})
		const endEditing = vi.fn()
		const { sync, editor } = setup({ server, endEditing })
		editor.elements = (await sync.open()).elements
		editor.edit(box('t', 2, 2, { type: 'text', text: 'Hello' }))
		editor.appState = { editingTextElement: { id: 't' }, scrollX: 120, zoom: { value: 2 } }

		// The same board, saved by someone under another file id: a later copy of a, nothing taken back
		server.replace([box('a', 2), box('t', 1, 1, { type: 'text', text: 'Hel' })], 'e2', { settings: { scrollX: 0, zoom: { value: 1 } } })
		await sync.fetch()
		await settle()

		expect(endEditing).not.toHaveBeenCalled()
		expect(editor.history.clear).not.toHaveBeenCalled()
		expect(editor.appState.scrollX).toBe(120)
		expect(editor.elements.find((element) => element.id === 't').text).toBe('Hello')
		expect(editor.elements.find((element) => element.id === 'a').version).toBe(2)
	})

	it('tries again soon when Nextcloud is busy as the board opens', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.busyGets = 1
		const { sync, editor, statuses } = setup({ server })

		expect(await sync.open()).toBeNull()
		expect(statuses.at(-1).unavailable).toBe(true)
		await advance(5_000)

		expect(statuses.at(-1).unavailable).toBe(false)
		expect(editor.elements.map((element) => element.id)).toEqual(['a'])
	})

	it('saves a change made while it waits to try a busy board again', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		server.busyGets = 1
		const { sync, editor } = setup({ server, scene: { account: 'alice', fileId: 1, elements: [box('a', 1)], files: {}, cachedAt: 1, server: { epoch: server.epoch, rev: server.rev, ids: ['a'], differing: [], files: [] } } })
		editor.elements = (await sync.open()).elements

		editor.edit(box('b', 1))
		sync.changed()
		await advance(60_000)

		expect(server.elements.has('b')).toBe(true)
	})

	it('shows a tab that cannot save the board as Nextcloud has it, without what this device kept unsaved', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, readOnly: true })
		await store.keep('e1', { elements: [box('a', 5, 5, { x: 99 })], files: {} })

		const data = await sync.open()

		expect(data.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
	})

	it('saves a change to an element stored without a version', async () => {
		const server = fakeNextcloud()
		server.elements.set('a', { id: 'a', type: 'rectangle', isDeleted: false })
		server.revs.set('a', 1)
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements.map((element) => ({ ...element, version: 1, versionNonce: 1 }))
		editor.edit(box('a', 2, 2, { x: 50 }))
		sync.changed()

		await advance(11_000)

		expect(sent(server)).toEqual([['a@2']])
	})
})

describe('BoardSync, when the page is hidden', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('keeps the last change on the device and sends it at once, as a hidden page may be frozen before any timer runs', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		editor.edit(box('b', 1))
		sync.changed()
		// Frozen right after: no answer, no timer
		server.hold = new Promise(() => {})

		sync.hidden()
		await Promise.resolve()

		expect((await rowsOf(store)).outbox.map((entry) => entry.element?.id)).toContain('b')
		expect(server.requests.filter((request) => request.method === 'PUT').map((request) => request.keepalive)).toEqual([true])
	})
})
