/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Excalidraw's reconcile: the higher version wins, equal versions the lower nonce; an element being edited keeps the local copy.
// Its restore gives an element out of fractional index order a new index and a new version.
vi.mock('@nextcloud/excalidraw', () => ({
	CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
	restoreElements: (elements) => {
		let last = null
		return (elements ?? []).map((element) => {
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

const { BoardSync } = await import('../../src/sync/boardSync.ts')
const { wins } = await import('../../src/utils/elementOrder.ts')

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
		unreadable: false,
		requests: [],
		hold: null,
		changesSince(since) {
			return {
				elements: [...server.elements.values()].filter((element) => server.revs.get(element.id) > since),
				files: Object.fromEntries(Object.entries(server.files).filter(([id]) => server.fileRevs.get(id) > since)),
			}
		},
		board() {
			return { elements: [...server.elements.values()], files: { ...server.files } }
		},
		write(elements, files) {
			const rev = server.rev + 1
			let changed = false
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
		replace(elements, epoch = 'e2') {
			server.epoch = epoch
			server.rev += 1
			server.elements = new Map(elements.map((element) => [element.id, element]))
			server.revs = new Map(elements.map((element) => [element.id, server.rev]))
		},
		async request(method, { query, body, path } = {}) {
			server.requests.push({ method, query, body, path })
			if (server.hold) {
				await server.hold
			}
			const sync = { epoch: server.epoch, rev: server.rev }
			if (server.unreadable && !(method === 'PUT' && body.sync.repair)) {
				return { status: 409, body: { code: 'board_unreadable', sync } }
			}
			if (method === 'GET') {
				if (query && query.epoch === server.epoch) {
					return { status: 200, body: { sync, delta: server.changesSince(Number(query.since)) } }
				}
				return { status: 200, body: { sync, data: server.board() } }
			}
			if (method === 'POST' && path === 'restore') {
				server.replace(body.data.elements, `e${server.rev + 1}`)
				return { status: 200, body: { sync: { epoch: server.epoch, rev: server.rev } } }
			}
			if (body.sync.epoch !== server.epoch) {
				return { status: 409, body: { code: 'board_replaced', sync } }
			}
			if (body.sync.repair) {
				server.unreadable = false
			}
			server.write(body.data.elements, body.data.files)
			return { status: 200, body: { sync: { epoch: server.epoch, rev: server.rev }, delta: server.changesSince(body.sync.since) } }
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
		updateScene: ({ elements }) => {
			editor.elements = elements
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

function fakeStore() {
	const store = {
		outbox: [],
		recovery: [],
		async keep(account, fileId, epoch, elements, files) {
			for (const element of elements) {
				const kept = store.outbox.find((entry) => entry.epoch === epoch && entry.element?.id === element.id)
				if (!kept) {
					store.outbox.push({ epoch, element })
				} else if (wins(element, kept.element)) {
					kept.element = element
				}
			}
			Object.values(files).forEach((file) => store.outbox.push({ epoch, file }))
		},
		async prune(account, fileId, epoch, serverHas) {
			store.outbox = store.outbox.filter((entry) => entry.epoch !== epoch || !serverHas(entry))
		},
		async kept(account, fileId, epoch) {
			const entries = store.outbox.filter((entry) => entry.epoch === epoch)
			return {
				elements: entries.flatMap((entry) => entry.element ?? []),
				files: Object.fromEntries(entries.flatMap((entry) => entry.file ? [[entry.file.id, entry.file]] : [])),
			}
		},
		async recover(account, fileId, epoch, extra = { elements: [], files: {} }) {
			const stale = epoch === null ? [] : store.outbox.filter((entry) => entry.epoch !== epoch)
			store.outbox = store.outbox.filter((entry) => !stale.includes(entry))
			const elements = [...stale.flatMap((entry) => entry.element ?? []), ...extra.elements]
			if (elements.length > 0) {
				store.recovery.push({ elements, files: extra.files })
			}
			return store.recovery.length > 0
		},
		scene: undefined,
		async saveScene(scene) {
			store.scene = scene
		},
		async loadScene() {
			return store.scene
		},
	}
	return store
}

function setup({ server = fakeNextcloud(), editor = fakeEditor(), readOnly = false, leader = true, inRoom = true, legacy = null, dropLegacy = vi.fn(async () => {}), scene, endEditing } = {}) {
	const store = fakeStore()
	store.scene = scene
	const announced = []
	const recoverable = vi.fn()
	const sync = new BoardSync({
		fileId: 1,
		account: 'alice',
		request: (method, options) => server.request(method, options),
		editor: () => editor,
		isReadOnly: () => readOnly,
		isLeader: () => leader,
		isInRoom: () => inRoom,
		announce: (type, state) => announced.push({ type, ...state }),
		onRecoverable: recoverable,
		store,
		legacyDraft: { read: async () => legacy, drop: dropLegacy },
		endEditing: () => endEditing?.(editor),
	})
	return { sync, server, editor, store, announced, recoverable }
}

const settle = () => vi.advanceTimersByTimeAsync(400)
const sent = (server) => server.requests.filter((request) => request.method === 'PUT').map((request) => request.body.data.elements.map((element) => `${element.id}@${element.version}`))

describe('BoardSync', () => {
	beforeEach(() => {
		vi.useFakeTimers()
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
		await vi.advanceTimersByTimeAsync(15_000)

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
		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`)).toContain('a@7')
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
		await sync.restore({ elements: [box('r', 1)], files: {} })
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
		await vi.advanceTimersByTimeAsync(20_000)
		expect(sent(server)).toEqual([])

		await vi.advanceTimersByTimeAsync(11_000)
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
		await vi.advanceTimersByTimeAsync(40_000)

		expect(sent(server)).toEqual([])
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
		await vi.advanceTimersByTimeAsync(100_000)
		expect(editor.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@4', 'n@1'])

		await vi.advanceTimersByTimeAsync(60_000)
		expect(editor.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
		expect(sent(server)).toEqual([])
	})

	it('repairs a board whose stored bytes cannot be read with the whole scene', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		server.unreadable = true
		server.elements.clear()

		editor.edit(box('b', 1))
		sync.changed()
		await settle()
		await vi.advanceTimersByTimeAsync(11_000)

		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
	})

	it('keeps a draft of the previous client for recovery instead of merging it', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const dropLegacy = vi.fn(async () => {})
		const { sync, store, recoverable } = setup({ server, legacy: { elements: [box('a', 30)], files: {} }, dropLegacy })

		const data = await sync.open()

		expect(data.elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1'])
		expect(store.recovery[0].elements[0].version).toBe(30)
		expect(recoverable).toHaveBeenCalled()
		expect(dropLegacy).toHaveBeenCalled()
	})

	it('keeps the draft of the previous client where it is when the recovery store fails', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const dropLegacy = vi.fn(async () => {})
		const { sync, store } = setup({ server, legacy: { elements: [box('a', 30)], files: {} }, dropLegacy })
		store.recover = async () => {
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
		store.recover = () => new Promise((resolve) => {
			finishRecovery = resolve
		})

		const fetching = sync.fetch()
		for (let i = 0; i < 20 && !finishRecovery; i++) {
			await Promise.resolve()
		}
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

		const { sync, editor } = setup({ server, scene: earlier.store.scene })
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
		await vi.advanceTimersByTimeAsync(20_000)
		expect([...server.elements.keys()].sort()).toEqual(['a', 'b'])
		expect(sent(server)).toEqual([['b@1']])
	})

	it('keeps edits made on a board that did not load for recovery, and then shows the stored board', async () => {
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
		await vi.advanceTimersByTimeAsync(20_000)
		expect(editor.elements.map((element) => element.id)).toEqual(['a'])
		expect([...server.elements.keys()]).toEqual(['a'])
		expect(recoverable).toHaveBeenCalledWith(false)
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
		expect(store.outbox.map((entry) => `${entry.element.id}@${entry.element.version}`)).toEqual(['a@6'])

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

	it('does not go back to its own restore when a later one arrived first', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		// Nextcloud restores at once, but the answer is late
		const respond = server.request
		let release = null
		const late = new Promise((resolve) => {
			release = resolve
		})
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'POST') {
				await late
			}
			return answer
		}

		const restoring = sync.restore({ elements: [box('mine', 1)], files: {} })
		await Promise.resolve()
		// Someone else restored another version after it, and this tab loaded that one
		await respond('POST', { path: 'restore', body: { data: { elements: [box('theirs', 1)] } } })
		await sync.fetch()
		release()
		await restoring

		expect(editor.elements.map((element) => element.id)).toEqual(['theirs'])
	})

	it('keeps an unsaved edit of the old epoch when the board is replaced before IndexedDB prunes', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server })
		editor.elements = (await sync.open()).elements
		// Another tab of this browser kept an edit and closed before saving it
		store.outbox.push({ epoch: server.epoch, element: box('a', 5) })
		// IndexedDB runs transactions in the order they were made, and this prune is slow
		let releasePrune = null
		const pruneGate = new Promise((resolve) => {
			releasePrune = resolve
		})
		const { prune, recover } = store
		let pruned = null
		store.prune = (...args) => {
			pruned = pruneGate.then(() => prune(...args))
			return pruned
		}
		store.recover = async (...args) => {
			await pruned
			return recover(...args)
		}

		const fetching = sync.fetch()
		await Promise.resolve()
		const restoring = sync.restore({ elements: [box('a', 10)], files: {} })
		await Promise.resolve()
		releasePrune()
		await Promise.all([fetching, restoring])

		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => `${element.id}@${element.version}`)).toEqual(['a@5'])
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
		await respond('POST', { path: 'restore', body: { data: { elements: [box('third', 1)] } } })
		await sync.fetch()
		release()
		await vi.advanceTimersByTimeAsync(1000)

		expect(editor.elements.map((element) => element.id)).toEqual(['third'])
	})

	it('keeps the unsaved changes of a replaced board in memory until IndexedDB takes them', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store, recoverable } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { recover } = store
		let failures = 2
		store.recover = async (...args) => {
			if (failures-- > 0) {
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		// Drawn just before the board is replaced, before it was kept
		editor.edit(box('x', 1))
		server.replace([box('b', 1)])

		await sync.fetch()
		await vi.advanceTimersByTimeAsync(10_000)

		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
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

		expect(Object.keys(store.recovery[0].files)).toEqual(['img'])
	})

	it('sends what this device kept for the board once Nextcloud answers, after opening without it', async () => {
		const server = fakeNextcloud()
		server.write([box('stored', 1)], {})
		const { sync, editor, store } = setup({ server })
		// Kept by an earlier visit that could not save it
		store.outbox.push({ epoch: server.epoch, element: box('draft', 1) })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		expect(await sync.open()).toBeNull()

		server.request = request
		await vi.advanceTimersByTimeAsync(75_000)
		await settle()
		expect(editor.elements.map((element) => element.id).sort()).toEqual(['draft', 'stored'])
		sync.changed()
		await vi.advanceTimersByTimeAsync(15_000)

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

		const { sync, editor } = setup({ server, scene: earlier.store.scene })
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
		expect(store.scene.appState.viewBackgroundColor).toBeUndefined()

		await vi.advanceTimersByTimeAsync(10_000)
		expect(store.scene.appState.viewBackgroundColor).toBe('#222222')

		editor.appState = { viewBackgroundColor: '#333333' }
		sync.flush()
		expect(store.scene.appState.viewBackgroundColor).toBe('#333333')
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
		const post = gate()
		const reload = gate()
		server.request = async (method, options) => {
			const answer = await respond(method, options)
			if (method === 'POST') {
				await post.promise
			} else if (method === 'GET' && !options?.query) {
				await reload.promise
			}
			return answer
		}
		// This tab's restore: a poll loads it before its answer arrives, and the load that follows answers late
		const restoring = sync.restore({ elements: [box('a', 1)], files: {} })
		await Promise.resolve()
		await sync.fetch()
		post.open()
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
		expect(store.recovery).toEqual([])
	})

	it('saves an image this device kept for the board once Nextcloud answers, after opening without it', async () => {
		const server = fakeNextcloud()
		const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], {})
		const { sync, store } = setup({ server })
		store.outbox.push({ epoch: server.epoch, file: image })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		await sync.open()

		server.request = request
		await vi.advanceTimersByTimeAsync(75_000)
		await vi.advanceTimersByTimeAsync(15_000)

		expect(Object.keys(server.files)).toEqual(['img'])
	})

	it('moves only changes of other boards than the shown one to recovery when IndexedDB recovers late', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { recover } = store
		let failures = 1
		store.recover = async (...args) => {
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

		await vi.advanceTimersByTimeAsync(5_000)

		expect(store.outbox.map((entry) => `${entry.epoch}:${entry.element.id}`)).toEqual(['e3:y'])
	})

	it('opens the restored board when Nextcloud answers with it while the copy on this device is still opening', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const earlier = setup({ server })
		earlier.editor.elements = (await earlier.sync.open()).elements
		earlier.sync.close()
		server.replace([box('restored', 1)])

		const { sync, store } = setup({ server, scene: earlier.store.scene, editor: null })
		const request = server.request
		server.request = async () => {
			throw new Error('offline')
		}
		const { kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.kept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		for (let i = 0; i < 20 && !keeping; i++) {
			await Promise.resolve()
		}
		server.request = request
		store.kept = kept
		await sync.fetch()
		releaseKept()

		expect((await opening).elements.map((element) => element.id)).toEqual(['restored'])
	})

	it('tries again to keep a replaced board\'s changes for recovery when the page closes', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, editor, store } = setup({ server, leader: false })
		editor.elements = (await sync.open()).elements
		const { recover } = store
		let failures = 1
		store.recover = async (...args) => {
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

		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
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
		const { recover } = store
		let release = null
		const slow = new Promise((resolve) => {
			release = resolve
		})
		let calls = 0
		store.recover = async (...args) => {
			if (calls++ === 0) {
				await slow
				throw new Error('QuotaExceededError')
			}
			return recover(...args)
		}
		editor.edit(box('x', 1))
		server.replace([box('b', 1)])
		const fetching = sync.fetch()
		for (let i = 0; i < 20 && calls === 0; i++) {
			await Promise.resolve()
		}
		// Another board opens while IndexedDB is still busy with the first try
		sync.close()
		release()
		await fetching
		await vi.advanceTimersByTimeAsync(5_000)

		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
	})

	it('opens with what this device kept for the board that overtook the open', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		server.replace([box('new', 1)], 'e2')
		// Kept by another tab of this browser that already had the new board
		store.outbox.push({ epoch: 'e2', element: box('draft', 1) })
		const { kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.kept = async (...args) => {
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
		for (let i = 0; i < 20 && !keeping; i++) {
			await Promise.resolve()
		}
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

		expect(store.outbox.map((entry) => entry.element.id)).toEqual(['b'])
	})

	it('opens with what Nextcloud saved while the board was opening', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.kept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		for (let i = 0; i < 20 && !keeping; i++) {
			await Promise.resolve()
		}
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
		await vi.advanceTimersByTimeAsync(5_000)

		expect(store.outbox.map((entry) => entry.element.id)).toEqual(['x'])
	})

	it('opens with the images of what Nextcloud saved while the board was opening', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.kept = async (...args) => {
			keeping = true
			await keptGate
			return kept(...args)
		}
		const opening = sync.open()
		for (let i = 0; i < 20 && !keeping; i++) {
			await Promise.resolve()
		}
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
		const { recover } = store
		let failures = 1
		store.recover = async (...args) => {
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
		store.outbox.push({ epoch: 'e3', element: box('y', 1) })

		await vi.advanceTimersByTimeAsync(5_000)

		expect(store.outbox.map((entry) => `${entry.epoch}:${entry.element.id}`)).toEqual(['e3:y'])
		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => element.id)).toContain('x')
	})

	it('opens the latest board when two others overtake the open one after the other', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { kept } = store
		const gates = []
		store.kept = async (...args) => {
			await new Promise((resolve) => gates.push(resolve))
			return kept(...args)
		}
		const opening = sync.open()
		const waitForKept = async (count) => {
			for (let i = 0; i < 50 && gates.length < count; i++) {
				await Promise.resolve()
			}
		}
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
		await vi.advanceTimersByTimeAsync(60_000)
		editor.edit(box('b', 2, 9, { index: 'a3' }))
		sync.changed()
		await vi.advanceTimersByTimeAsync(100_000)

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

		expect(store.outbox.map((entry) => entry.element.id)).toEqual(['b'])
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
		await vi.advanceTimersByTimeAsync(115_000)
		// Edit rights arrive, and this tab edits the element
		readOnly = false
		editor.edit(box('a', 3))
		sync.changed()
		await vi.advanceTimersByTimeAsync(10_000)

		expect(editor.elements.find((element) => element.id === 'a').version).toBe(3)
		expect(store.outbox.map((entry) => `${entry.element.id}@${entry.element.version}`)).toContain('a@3')
	})

	it('opens with the images of the board that overtook the open, not those of the earlier one', async () => {
		const server = fakeNextcloud()
		server.write([box('a', 1)], {})
		const { sync, store } = setup({ server, editor: null })
		const { kept } = store
		let releaseKept = null
		const keptGate = new Promise((resolve) => {
			releaseKept = resolve
		})
		let keeping = false
		store.kept = async (...args) => {
			if (!keeping) {
				keeping = true
				await keptGate
			}
			return kept(...args)
		}
		const opening = sync.open()
		for (let i = 0; i < 20 && !keeping; i++) {
			await Promise.resolve()
		}
		const before = { id: 'img', dataURL: 'data:image/png;base64,OLD', mimeType: 'image/png' }
		const after = { id: 'img', dataURL: 'data:image/png;base64,NEW', mimeType: 'image/png' }
		server.write([box('i', 1, 1, { type: 'image', fileId: 'img' })], { img: before })
		await sync.fetch()
		// The file is replaced; the new board has other bytes under the same image id
		server.replace([box('i', 1, 1, { type: 'image', fileId: 'img' })], 'e2')
		server.files = { img: after }
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
		expect(store.recovery.flatMap((entry) => entry.elements).map((element) => element.text)).toEqual(['typed before the restore'])
	})

	it('keeps an edit that finished after its board was replaced for recovery', async () => {
		const server = fakeNextcloud()
		const { sync, editor, store, recoverable } = setup({ server })
		editor.elements = (await sync.open()).elements
		const image = { id: 'table-image', dataURL: 'data:image/svg+xml;base64,AAAA', mimeType: 'image/svg+xml' }

		sync.keepForLater({ elements: [box('table', 2, 7, { type: 'image', fileId: 'table-image' })], files: { 'table-image': image } })
		await settle()

		expect(store.recovery[0].elements.map((element) => element.id)).toEqual(['table'])
		expect(Object.keys(store.recovery[0].files)).toEqual(['table-image'])
		expect(recoverable).toHaveBeenCalledWith(false)
	})

	it('catches up again after a request that never ends', async () => {
		const server = fakeNextcloud()
		server.write([box('old', 1)], {})
		const { sync, editor } = setup({ server })
		editor.elements = (await sync.open()).elements
		const respond = server.request
		let hung = true
		server.request = (method, options) => hung && method === 'GET' ? new Promise(() => {}) : respond(method, options)
		const first = sync.fetch()
		hung = false
		server.replace([box('new', 1)], 'e2')
		sync.hint({ epoch: 'e2', rev: server.rev })

		await vi.advanceTimersByTimeAsync(65_000)
		await first.catch(() => {})
		await vi.advanceTimersByTimeAsync(5_000)

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
		await vi.advanceTimersByTimeAsync(15_000)
		expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
	})
})
