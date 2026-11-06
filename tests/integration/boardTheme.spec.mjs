/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { useThemeHandling } from '../../src/hooks/useThemeHandling.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('board theme', () => {
	let board
	let changeTheme

	const excalidrawAPI = {
		onChange: (callback) => {
			changeTheme = (theme) => callback([], { theme }, {})
			return () => {}
		},
	}

	function Board() {
		board = useThemeHandling(excalidrawAPI)
		return null
	}

	async function open() {
		await act(async () => createRoot(document.createElement('div')).render(createElement(Board)))
	}

	beforeEach(() => {
		localStorage.clear()
		document.body.dataset.themes = 'light'
		window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
	})

	it('follows the Nextcloud theme by default', async () => {
		await open()

		expect(board).toEqual({ theme: 'light', themeAttributes: {} })
	})

	it('keeps a board theme picked in the menu', async () => {
		await open()
		await act(async () => changeTheme('dark'))

		expect(board).toEqual({ theme: 'dark', themeAttributes: { 'data-theme-dark': '' } })

		await open()
		expect(board.theme).toBe('dark')
	})

	it('follows Nextcloud again when the user picks its theme', async () => {
		await open()
		await act(async () => changeTheme('dark'))
		await act(async () => changeTheme('light'))

		expect(board).toEqual({ theme: 'light', themeAttributes: {} })
		expect(localStorage.getItem('whiteboard-theme')).toBeNull()
	})

	it('keeps the high-contrast variant of a theme', async () => {
		document.body.dataset.themes = 'light-highcontrast'
		await open()
		await act(async () => changeTheme('dark'))

		expect(board.themeAttributes).toEqual({ 'data-theme-dark-highcontrast': '' })
	})

	it('gives dialogs rendered outside of the board the same theme', async () => {
		await open()
		await act(async () => changeTheme('dark'))
		const dialog = document.createElement('div')
		dialog.className = 'excalidraw excalidraw-modal-container'
		await act(async () => document.body.append(dialog))

		expect(dialog.hasAttribute('data-theme-dark')).toBe(true)

		await act(async () => changeTheme('light'))

		expect(dialog.hasAttribute('data-theme-dark')).toBe(false)
		dialog.remove()
	})
})
