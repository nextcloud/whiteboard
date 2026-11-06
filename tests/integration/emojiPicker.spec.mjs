/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const picker = vi.hoisted(() => ({ listeners: null }))

vi.mock('@nextcloud/router', () => ({ imagePath: (app, file) => `/apps/${app}/img/${file}` }))
vi.mock('../../src/components/EmojiPickerButton.vue', () => ({ default: {} }))
vi.mock('../../src/components/ToolbarButton.tsx', () => ({
	renderToolbarButton: ({ customContainer }) => customContainer(document.createElement('div')),
	resetActiveTool: () => {},
}))
vi.mock('../../src/utils/vue.ts', () => ({
	mountVueComponent: (component, target, props, listeners) => {
		picker.listeners = listeners
	},
}))

const { useEmojiPicker } = await import('../../src/hooks/useEmojiPicker.tsx')
const { useExcalidrawStore } = await import('../../src/stores/useExcalidrawStore.ts')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('inserting an emoji', () => {
	let root
	let editor

	function Board() {
		useEmojiPicker().renderEmojiPicker()
		return null
	}

	beforeEach(async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>' })))
		editor = {
			elements: [],
			addFiles: vi.fn(),
			getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 }),
			getSceneElementsIncludingDeleted: () => editor.elements,
			updateScene: vi.fn(({ elements }) => {
				editor.elements = elements
			}),
		}
		useExcalidrawStore.setState({ excalidrawAPI: editor })
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
	})

	afterEach(async () => {
		await act(async () => root.unmount())
		vi.unstubAllGlobals()
	})

	it('marks the emoji image to keep its colors in dark mode', async () => {
		await act(async () => picker.listeners.selected({ native: '😀' }))

		expect(editor.elements).toHaveLength(1)
		expect(editor.elements[0]).toMatchObject({
			type: 'image',
			customData: { keepColorsInDarkMode: true },
		})
	})

	it('keeps the mark while the emoji follows the pointer', async () => {
		await act(async () => picker.listeners.selected({ native: '😀' }))
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 80 }))

		expect(editor.elements[0]).toMatchObject({
			x: 120,
			y: 80,
			customData: { keepColorsInDarkMode: true },
		})
	})
})
