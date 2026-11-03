/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useEffect } from 'react'
import type { Theme } from '@nextcloud/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'

// The board theme the user picked in the main menu, kept only while it differs from the Nextcloud theme
const STORAGE_KEY = 'whiteboard-theme'

function nextcloudTheme(): Theme {
	const ncThemes = document.body.dataset?.themes
	const followsSystem = ncThemes === undefined || !ncThemes.includes('light')
	const isDark = (followsSystem && window.matchMedia('(prefers-color-scheme: dark)').matches) || !!ncThemes?.includes('dark')
	return isDark ? 'dark' : 'light'
}

function storedTheme(): Theme | null {
	const stored = localStorage.getItem(STORAGE_KEY)
	return stored === 'light' || stored === 'dark' ? stored : null
}

function chosenTheme(): Theme {
	return storedTheme() ?? nextcloudTheme()
}

export function useThemeHandling(excalidrawAPI: ExcalidrawImperativeAPI | null = null) {
	const [theme, setTheme] = useState<Theme>(chosenTheme)

	useEffect(() => {
		const themeChangeListener = () => setTheme(chosenTheme())
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		mq.addEventListener('change', themeChangeListener)
		return () => {
			mq.removeEventListener('change', themeChangeListener)
		}
	}, [])

	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}
		return excalidrawAPI.onChange((_elements, appState) => {
			if (appState.theme === theme) {
				return
			}
			if (appState.theme === nextcloudTheme()) {
				localStorage.removeItem(STORAGE_KEY)
			} else {
				localStorage.setItem(STORAGE_KEY, appState.theme)
			}
			setTheme(appState.theme)
		})
	}, [excalidrawAPI, theme])

	// Nextcloud's theme variables for the board's theme, so the controls around the canvas match it,
	// in the high-contrast variant when the user has chosen that one
	const highContrast = document.body.dataset?.themes?.includes('highcontrast') ? '-highcontrast' : ''
	const themeAttribute = storedTheme() === theme ? `data-theme-${theme}${highContrast}` : null

	// Excalidraw renders its dialogs in containers of their own at the end of the body
	useEffect(() => {
		if (!themeAttribute) {
			return
		}
		const portals = () => document.querySelectorAll('body > .excalidraw')
		const apply = () => portals().forEach((portal) => portal.setAttribute(themeAttribute, ''))
		apply()
		const observer = new MutationObserver(apply)
		observer.observe(document.body, { childList: true })
		return () => {
			observer.disconnect()
			portals().forEach((portal) => portal.removeAttribute(themeAttribute))
		}
	}, [themeAttribute])

	return { theme, themeAttributes: themeAttribute ? { [themeAttribute]: '' } : {} }
}
