/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeElementVersionHash, computeSceneKey } from '../../src/utils/syncSceneData.ts'

const records = vi.hoisted(() => new Map())
const gates = vi.hoisted(() => ({ put: null, puts: 0 }))
const markSaved = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../src/database/db.ts', () => ({
	db: {
		get: vi.fn(async (fileId) => records.get(fileId)),
		put: vi.fn(async (fileId, elements, files, appState, options = {}) => {
			gates.puts++
			await gates.put
			const existing = records.get(fileId)
			records.set(fileId, {
				elements,
				files,
				appState,
				hasPendingLocalChanges: options.hasPendingLocalChanges ?? existing?.hasPendingLocalChanges ?? false,
			})
			return fileId
		}),
		markSaved,
	},
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferredResponse() {
	let resolve
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const ok = { ok: true, status: 200, json: async () => ({ status: 'success' }) }
const scene = (version) => [{ id: 'A', version, versionNonce: version }]
const keyOf = (version) => computeSceneKey(scene(version), {})

describe('sync worker', () => {
	let send
	let worker
	let responses

	beforeEach(async () => {
		vi.resetModules()
		markSaved.mockClear()
		records.clear()
		gates.put = null
		gates.puts = 0
		responses = []
		vi.stubGlobal('fetch', vi.fn(() => {
			const response = deferredResponse()
			responses.push(response)
			return response.promise
		}))
		worker = {
			addEventListener: vi.fn(),
			postMessage: vi.fn(),
			performance: globalThis.performance,
		}
		vi.stubGlobal('self', worker)
		await import('../../src/workers/syncWorker.ts')
		const listener = worker.addEventListener.mock.calls[0][1]
		send = (data) => listener({ data })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const save = (sceneKey, fileId = 1, version = 1) => send({
		type: 'SYNC_TO_SERVER',
		fileId,
		url: `/board/${fileId}`,
		jwt: 'jwt',
		elements: scene(version),
		files: {},
		sceneKey,
	})

	const saveLocal = (version, hasPendingLocalChanges, fileId = 1) => send({
		type: 'SYNC_TO_LOCAL',
		fileId,
		elements: scene(version),
		files: {},
		hasPendingLocalChanges,
	})

	const flushBoard = (id, fileId, server) => send({ type: 'FLUSH', id, fileId, server })

	const sentScenes = () => fetch.mock.calls.map(([url, init]) => `${url}@${JSON.parse(init.body).data.elements[0].version}`)
	const sentTypes = () => worker.postMessage.mock.calls.map(([message]) => message.type)

	it('sends one save at a time and only the newest waiting scene of a board', async () => {
		save('k1', 1, 1)
		await flush()
		save('k2', 1, 2)
		save('k3', 1, 3)
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)

		responses[0].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/1@3'])
	})

	it('drops the waiting scene of a board but not the running save or other boards', async () => {
		save('k1', 1, 1)
		await flush()
		save('k2', 1, 2)
		save('b1', 2, 1)
		await flush()
		save('b2', 2, 2)
		send({ type: 'DROP_WAITING_SERVER_SYNC', fileId: 1 })
		flushBoard(9, 1, true)

		responses[0].resolve(ok)
		responses[1].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/2@1', '/board/2@2'])
		expect(worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH_COMPLETE', id: 9 })

		save('k3', 1, 3)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/2@1', '/board/2@2', '/board/1@3'])
	})

	it('saves another board while a save of one board is still running', async () => {
		save('k1', 1, 1)
		await flush()
		save('k2', 1, 2)
		save('b1', 2, 1)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/2@1'])

		responses[0].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/2@1', '/board/1@2'])
	})

	it('uploads a scene again when it is sent again', async () => {
		save('k1', 1)
		await flush()
		responses[0].resolve(ok)
		await flush()
		save('k1', 1)
		await flush()
		responses[1].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/1@1'])
		expect(sentTypes()).toEqual(['SERVER_SYNC_COMPLETE', 'SERVER_SYNC_COMPLETE'])
	})

	it('reports a 409 as an error and retries the scene', async () => {
		save('k1')
		await flush()
		responses[0].resolve({ ok: false, status: 409, text: async () => '{"status":"conflict"}' })
		await flush()

		expect(sentTypes()).toEqual(['SERVER_SYNC_ERROR'])

		save('k1')
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it('stores the pending flag it is given for a local save', async () => {
		saveLocal(1, false)
		await flush()

		expect(records.get(1).hasPendingLocalChanges).toBe(false)
	})

	const isUploadedScene = (stored) => markSaved.mock.calls[0][4](stored)

	it('marks the board saved with the uploaded scene once the upload finishes', async () => {
		save(keyOf(1), 1, 1)
		await flush()
		expect(markSaved).not.toHaveBeenCalled()

		responses[0].resolve(ok)
		await flush()

		expect(markSaved).toHaveBeenCalledWith(1, scene(1), {}, computeElementVersionHash(scene(1)), expect.any(Function))
		expect(isUploadedScene({ elements: scene(1), files: {} })).toBe(true)
	})

	it('does not take a newer local draft for the uploaded scene', async () => {
		save(keyOf(1), 1, 1)
		await flush()
		responses[0].resolve(ok)
		await flush()

		expect(isUploadedScene({ elements: scene(2), files: {} })).toBe(false)
	})

	it('does not take a local draft with other files for the uploaded scene', async () => {
		save(keyOf(1), 1, 1)
		await flush()
		responses[0].resolve(ok)
		await flush()

		expect(isUploadedScene({ elements: scene(1), files: { image: { id: 'image' } } })).toBe(false)
	})

	it('reports a flush of a board once its local writes are done', async () => {
		let release
		gates.put = new Promise((resolve) => {
			release = resolve
		})
		saveLocal(2, true)
		flushBoard(7, 1, false)
		flushBoard(8, 2, false)
		await flush()

		expect(sentTypes()).toEqual(['FLUSH_COMPLETE'])
		expect(worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH_COMPLETE', id: 8 })

		release()
		await flush()

		expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'FLUSH_COMPLETE', id: 7 })
		expect(records.get(1)).toMatchObject({ elements: scene(2), hasPendingLocalChanges: true })
	})

	it('reports a server flush of a board once its running and waiting saves are done', async () => {
		save('k1', 1, 1)
		await flush()
		save('k2', 1, 2)
		flushBoard(9, 1, true)
		responses[0].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/1@2'])
		expect(sentTypes()).toEqual(['SERVER_SYNC_COMPLETE'])

		responses[1].resolve(ok)
		await flush()

		expect(sentTypes()).toEqual(['SERVER_SYNC_COMPLETE', 'SERVER_SYNC_COMPLETE', 'FLUSH_COMPLETE'])
	})

	it('writes the local copies of a board one at a time', async () => {
		let release
		gates.put = new Promise((resolve) => {
			release = resolve
		})
		saveLocal(1, true)
		saveLocal(2, true)
		await flush()

		expect(gates.puts).toBe(1)

		release()
		await flush()

		expect(gates.puts).toBe(2)
		expect(records.get(1)).toMatchObject({ elements: scene(2), hasPendingLocalChanges: true })
	})
})
