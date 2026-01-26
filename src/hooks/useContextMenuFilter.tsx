/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useEffect } from 'react'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

const CONTEXT_MENU_FILTERS: Record<string, string[]> = {
	text: ['flipHorizontal', 'flipVertical'],
	embeddable: ['flipHorizontal', 'flipVertical'],
}

const hideAdjacentSeparators = (): void => {
	document.querySelectorAll('.context-menu-item-separator').forEach(separator => {
		let nextVisible = separator.nextElementSibling

		while (nextVisible && (nextVisible as HTMLElement).style.display === 'none') {
			nextVisible = nextVisible.nextElementSibling
		}

		if (nextVisible?.classList.contains('context-menu-item-separator')) {
			(separator as HTMLElement).style.display = 'none'
		}
	})
}

export const useContextMenuFilter = (excalidrawAPI: ExcalidrawImperativeAPI | null) => {
	useEffect(() => {
		if (!excalidrawAPI) return

		const handleContextMenu = () => {
			requestAnimationFrame(() => {
				const { selectedElementIds } = excalidrawAPI.getAppState()
				const elements = excalidrawAPI.getSceneElements()
				const selected = elements.filter(el => selectedElementIds[el.id])

				if (selected.length === 0) return

				const itemsToHide = new Set<string>()
				selected.forEach(el => {
					CONTEXT_MENU_FILTERS[el.type]?.forEach(item => itemsToHide.add(item))
				})

				itemsToHide.forEach(testId => {
					document.querySelector(`li[data-testid="${testId}"]`)?.setAttribute('style', 'display: none')
				})

				hideAdjacentSeparators()
			})
		}

		const container = document.querySelector('.excalidraw')
		container?.addEventListener('contextmenu', handleContextMenu)
		return () => container?.removeEventListener('contextmenu', handleContextMenu)
	}, [excalidrawAPI])
}
