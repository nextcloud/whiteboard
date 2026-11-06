/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nextcloud/dialogs', () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() }))
vi.mock('../../src/sync/createBoardSync.ts', () => ({
	boardAccount: () => 'alice',
	createBoardSync: (fileId) => ({ fileId, open: () => new Promise(() => {}), close: () => {} }),
}))

const { useBoardDataManager } = await import('../../src/hooks/useBoardDataManager.ts')
const { useVersionPreview } = await import('../../src/hooks/useVersionPreview.ts')
const { useExcalidrawStore } = await import('../../src/stores/useExcalidrawStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')
const { getBoardSync, setBoardSync } = await import('../../src/sync/boardSync.ts')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('opening and leaving boards and versions', () => {
	let root

	afterEach(async () => {
		await act(async () => root?.unmount())
		root = null
		setBoardSync(null)
		useWhiteboardConfigStore.setState({ isVersionPreview: false, versionSource: null, fileVersion: null, isReadOnly: false })
	})

	it('closes the live board before a version preview makes it read-only', async () => {
		let readOnlyWhenClosed = null
		setBoardSync({ close: () => {
			readOnlyWhenClosed = useWhiteboardConfigStore.getState().isReadOnly
		} })
		useWhiteboardConfigStore.setState({ fileId: 1, isReadOnly: false })
		const options = { fileId: 1, excalidrawAPI: null, refreshReadOnlyState: async () => false, isReadOnly: false }
		function Board({ versionSource, fileVersion }) {
			useVersionPreview({ ...options, versionSource, fileVersion })
			return null
		}
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board, { versionSource: null, fileVersion: null })))

		await act(async () => root.render(createElement(Board, { versionSource: '/remote.php/dav/versions/alice/versions/1/2', fileVersion: '2' })))

		// It could still send what it had not saved
		expect(readOnlyWhenClosed).toBe(false)
		expect(useWhiteboardConfigStore.getState().isReadOnly).toBe(true)
	})

	it('closes the board shown so far before the editor is cleared for the next one', async () => {
		const order = []
		setBoardSync({ close: () => order.push('close') })
		useExcalidrawStore.setState({ excalidrawAPI: { resetScene: () => order.push('reset') } })
		globalThis.fetch = vi.fn(() => new Promise(() => {}))
		useWhiteboardConfigStore.setState({ fileId: 2, isVersionPreview: true, versionSource: '/versions/A', fileVersion: 'A' })
		function Board() {
			useBoardDataManager()
			return null
		}
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))

		// The board still has its scene when it closes, so it can send what it has not saved
		expect(order.slice(0, 2)).toEqual(['close', 'reset'])
		useExcalidrawStore.setState({ excalidrawAPI: null })
	})

	it('leaves the board another viewer page opened when it closes', async () => {
		useWhiteboardConfigStore.setState({ fileId: 1 })
		function Board() {
			useBoardDataManager()
			return null
		}
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
		const own = getBoardSync()
		expect(own.fileId).toBe(1)

		await act(async () => root.unmount())
		expect(getBoardSync()).toBe(null)

		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
		const next = { fileId: 2, close: () => {} }
		setBoardSync(next)
		await act(async () => root.unmount())
		root = null
		expect(getBoardSync()).toBe(next)
	})

	it('shows the version opened last when an earlier opening of it fails late', async () => {
		const answers = new Map()
		globalThis.fetch = vi.fn(() => new Promise((resolve) => {
			answers.set(answers.size, resolve)
		}))
		const board = (id) => ({ ok: true, status: 200, text: async () => JSON.stringify({ elements: [{ id, type: 'rectangle', version: 1, versionNonce: 1 }] }) })
		function Board() {
			useBoardDataManager()
			return null
		}
		useWhiteboardConfigStore.setState({ fileId: 1, isVersionPreview: true, versionSource: '/versions/A', fileVersion: 'A' })
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
		// Version B, then version A again
		await act(async () => useWhiteboardConfigStore.setState({ versionSource: '/versions/B', fileVersion: 'B' }))
		await act(async () => useWhiteboardConfigStore.setState({ versionSource: '/versions/A', fileVersion: 'A' }))
		expect(globalThis.fetch.mock.calls.map(([url]) => url)).toEqual(['/versions/A', '/versions/B', '/versions/A'])

		// The first opening of A fails after the last one started
		await act(async () => answers.get(0)({ ok: false, status: 500, text: async () => '' }))
		await act(async () => answers.get(2)(board('from-A')))

		const shown = await useWhiteboardConfigStore.getState().initialDataPromise
		expect(shown.elements.map((element) => element.id)).toEqual(['from-A'])
	})
})
