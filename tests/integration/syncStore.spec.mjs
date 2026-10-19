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
		useSyncStore.setState({ worker: null, isWorkerReady: false, savedSceneKey: null })
		useWhiteboardConfigStore.setState({ fileId: 1 })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

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
})
