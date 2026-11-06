/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editor = vi.hoisted(() => ({ props: null, scene: [], api: null }))

vi.mock('@nextcloud/excalidraw', async () => {
	const { useEffect } = await import('react')
	return {
		restoreElements: (elements) => elements,
		// As the pinned Excalidraw: it hands its API over through onExcalidrawAPI
		Excalidraw: (props) => {
			editor.props = props
			useEffect(() => {
				editor.scene = props.initialData?.elements ?? []
				editor.api = {
					addFiles: () => {},
					getAppState: () => ({}),
					updateScene: ({ elements }) => {
						editor.scene = elements
					},
				}
				props.onExcalidrawAPI?.(editor.api)
				return () => props.onExcalidrawAPI?.(null)
			}, [])
			return null
		},
	}
})
vi.mock('../../src/hooks/useThemeHandling', () => ({ useThemeHandling: () => ({ theme: 'light', themeAttributes: {} }) }))

const { default: ReadOnlyViewer } = await import('../../src/components/ReadOnlyViewer.tsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const board = (...ids) => JSON.stringify({ elements: ids.map((id) => ({ id, type: 'rectangle', version: 1, versionNonce: 1 })), files: {} })

describe('a live board embedded in Talk or Text', () => {
	let root
	let answers

	beforeEach(() => {
		vi.useFakeTimers()
		Object.assign(editor, { props: null, scene: [], api: null })
		answers = []
		globalThis.fetch = vi.fn(async () => {
			const next = answers.shift() ?? { status: 304, body: '' }
			if (next.fail) {
				throw new Error('offline')
			}
			return { ok: next.status === 200, status: next.status, headers: { get: () => next.etag ?? null }, text: async () => next.body }
		})
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
		root = createRoot(document.createElement('div'))
	})

	afterEach(async () => {
		await act(async () => root.unmount())
		vi.useRealTimers()
	})

	const show = () => act(async () => {
		root.render(createElement(ReadOnlyViewer, { fileName: 'Board', versionSource: '/remote.php/dav/files/alice/Board.whiteboard', fileVersion: null }))
	})

	it('shows what others saved after it opened', async () => {
		answers.push({ status: 200, body: board('a'), etag: 'e1' }, { status: 200, body: board('a', 'b'), etag: 'e2' })
		await show()
		await act(async () => vi.advanceTimersByTimeAsync(0))
		expect(editor.scene.map((element) => element.id)).toEqual(['a'])

		await act(async () => vi.advanceTimersByTimeAsync(60_000))

		expect(editor.scene.map((element) => element.id)).toEqual(['a', 'b'])
	})

	it('shows an empty board when the file was emptied', async () => {
		answers.push({ status: 200, body: board('a'), etag: 'e1' }, { status: 200, body: '', etag: 'e2' })
		await show()
		await act(async () => vi.advanceTimersByTimeAsync(0))

		await act(async () => vi.advanceTimersByTimeAsync(60_000))

		expect(editor.scene).toEqual([])
	})

	it('loads the board again when the first load failed', async () => {
		answers.push({ fail: true }, { status: 200, body: board('a'), etag: 'e1' })
		await show()
		await act(async () => vi.advanceTimersByTimeAsync(0))
		expect(editor.props).toBeNull()

		await act(async () => vi.advanceTimersByTimeAsync(60_000))

		expect(editor.scene.map((element) => element.id)).toEqual(['a'])
	})
})
