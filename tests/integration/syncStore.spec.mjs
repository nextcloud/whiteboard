/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncStore } from '../../src/stores/useSyncStore.ts'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore.ts'

describe('sync store', () => {
	beforeEach(() => {
		vi.stubGlobal('Worker', vi.fn(function() {
			return { postMessage: vi.fn(), terminate: vi.fn() }
		}))
		useSyncStore.setState({ worker: null, isWorkerReady: false, savedSceneKey: null, pausedFileId: null })
		useWhiteboardConfigStore.setState({ fileId: 1 })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	const flushId = (worker) => worker.postMessage.mock.calls.find(([message]) => message.type === 'FLUSH')[0].id

	it('reuses the worker for the next board', () => {
		const worker = useSyncStore.getState().initializeWorker()

		expect(useSyncStore.getState().initializeWorker()).toBe(worker)
		expect(Worker).toHaveBeenCalledOnce()
		expect(worker.terminate).not.toHaveBeenCalled()
	})

	it('remembers only the saved scene of the open board', () => {
		const worker = useSyncStore.getState().initializeWorker()

		worker.onmessage({ data: { type: 'SERVER_SYNC_COMPLETE', fileId: 1, sceneKey: 'k1' } })
		worker.onmessage({ data: { type: 'SERVER_SYNC_COMPLETE', fileId: 2, sceneKey: 'k2' } })

		expect(useSyncStore.getState().savedSceneKey).toBe('k1')
	})

	it('creates a new worker when the first one failed to load', () => {
		const failed = useSyncStore.getState().initializeWorker()
		failed.onerror({ message: 'Failed to fetch' })

		expect(failed.terminate).toHaveBeenCalledOnce()
		expect(useSyncStore.getState().initializeWorker()).not.toBe(failed)
		expect(Worker).toHaveBeenCalledTimes(2)
	})

	it('keeps a running worker after an error', () => {
		const worker = useSyncStore.getState().initializeWorker()
		worker.onmessage({ data: { type: 'INIT_COMPLETE' } })
		worker.onerror({ message: 'Uncaught error' })

		expect(worker.terminate).not.toHaveBeenCalled()
		expect(useSyncStore.getState().initializeWorker()).toBe(worker)
	})

	it('finishes a board flush when the worker reports it, also while it is still loading', async () => {
		const worker = useSyncStore.getState().initializeWorker()
		let flushed = false
		const flush = useSyncStore.getState().flushBoard(1).then(() => {
			flushed = true
		})
		const id = flushId(worker)
		expect(worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH', fileId: 1, id, server: false })

		worker.onmessage({ data: { type: 'FLUSH_COMPLETE', id: id + 1 } })
		await Promise.resolve()
		expect(flushed).toBe(false)

		worker.onmessage({ data: { type: 'FLUSH_COMPLETE', id } })
		await flush
		expect(flushed).toBe(true)
	})

	it('finishes a board flush at once without a worker, and when the worker fails to load', async () => {
		await useSyncStore.getState().flushBoard(1)

		const worker = useSyncStore.getState().initializeWorker()
		const flush = useSyncStore.getState().flushBoard(1)
		worker.onerror({ message: 'Failed to fetch' })
		await flush
	})

	it('pauses the saves of a board until the saves it queued are done', async () => {
		const worker = useSyncStore.getState().initializeWorker()
		const paused = useSyncStore.getState().pauseSaves(1)

		expect(useSyncStore.getState().pausedFileId).toBe(1)
		expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'FLUSH', fileId: 1, server: true }))

		worker.onmessage({ data: { type: 'FLUSH_COMPLETE', id: flushId(worker) } })
		await paused
		useSyncStore.getState().resumeSaves()
		expect(useSyncStore.getState().pausedFileId).toBeNull()
	})

	it('fails the pause when a queued save of the board does not finish in time', async () => {
		vi.useFakeTimers()
		useSyncStore.getState().initializeWorker()
		const paused = useSyncStore.getState().pauseSaves(1)
		const failed = expect(paused).rejects.toThrow('The board is still saving')

		await vi.advanceTimersByTimeAsync(60_000)
		await failed
	})
})
