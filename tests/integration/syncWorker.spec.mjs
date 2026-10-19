/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const records = vi.hoisted(() => new Map())

vi.mock('../../src/database/db.ts', () => ({
	db: {
		get: vi.fn(async (fileId) => records.get(fileId)),
		put: vi.fn(async (fileId, elements, files, appState, options = {}) => {
			const existing = records.get(fileId)
			records.set(fileId, {
				elements,
				files,
				appState,
				hasPendingLocalChanges: options.hasPendingLocalChanges ?? existing?.hasPendingLocalChanges ?? false,
			})
			return fileId
		}),
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

describe('sync worker', () => {
	let send
	let worker
	let responses

	beforeEach(async () => {
		vi.resetModules()
		records.clear()
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

	it('keeps the waiting save of a board when another board saves', async () => {
		save('k1', 1, 1)
		await flush()
		save('k2', 1, 2)
		save('b1', 2, 1)
		responses[0].resolve(ok)
		await flush()
		responses[1].resolve(ok)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/1@2', '/board/2@1'])
	})

	it('skips a scene that was already saved for the same board', async () => {
		save('k1', 1)
		await flush()
		responses[0].resolve(ok)
		await flush()
		save('k1', 1)
		save('k1', 2)
		await flush()

		expect(sentScenes()).toEqual(['/board/1@1', '/board/2@1'])
		expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SERVER_SYNC_COMPLETE', fileId: 1, sceneKey: 'k1' }))
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

	it('marks the local copy clean when it holds the saved scene', async () => {
		saveLocal(1, true)
		save('k1', 1, 1)
		await flush()
		responses[0].resolve(ok)
		await flush()

		expect(records.get(1)).toMatchObject({ elements: scene(1), hasPendingLocalChanges: false })
	})

	it('keeps a newer local draft when an older save finishes', async () => {
		save('k1', 1, 1)
		await flush()
		saveLocal(2, true)
		await flush()
		responses[0].resolve(ok)
		await flush()

		expect(records.get(1)).toMatchObject({ elements: scene(2), hasPendingLocalChanges: true })
	})
})
