/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useEffect } from 'react'
import type { Theme } from '@excalidraw/excalidraw/types/types'

export function useThemeHandling() {
	const [theme, setTheme] = useState<Theme>('light')

	const isDarkMode = () => {
		const ncThemes = document.body.dataset?.themes
		return (
			(window.matchMedia('(prefers-color-scheme: dark)').matches
				&& (ncThemes === undefined
					|| ncThemes?.indexOf('light') === -1))
			|| ncThemes?.indexOf('dark') > -1
		)
	}

	useEffect(() => {
		setTheme(isDarkMode() ? 'dark' : 'light')
	}, [])

	useEffect(() => {
		const themeChangeListener = () =>
			setTheme(isDarkMode() ? 'dark' : 'light')
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		mq.addEventListener('change', themeChangeListener)
		return () => {
			mq.removeEventListener('change', themeChangeListener)
		}
	}, [])

	return { theme }
}
