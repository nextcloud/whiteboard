/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'

interface ExcalidrawStore {
	excalidrawAPI: ExcalidrawImperativeAPI | null

	setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
	resetExcalidrawAPI: () => void
	scrollToContent: () => void
}

type WhiteboardTestHooks = {
	excalidrawStore?: {
		getState?: () => {
			excalidrawAPI: ExcalidrawImperativeAPI | null
		}
	}
}

declare global {
	interface Window {
		__whiteboardTest?: boolean
		__whiteboardTestHooks?: WhiteboardTestHooks & Record<string, unknown>
	}
}

const attachTestHooks = () => {
	if (typeof window === 'undefined' || !window.__whiteboardTest) {
		return
	}

	window.__whiteboardTestHooks = window.__whiteboardTestHooks || {}
	window.__whiteboardTestHooks.excalidrawStore = useExcalidrawStore
}

export const useExcalidrawStore = create<ExcalidrawStore>((set, get) => ({
	excalidrawAPI: null,

	setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => {
		set({ excalidrawAPI: api })
		attachTestHooks()
	},
	resetExcalidrawAPI: () => {
		set({ excalidrawAPI: null })
		attachTestHooks()
	},
	scrollToContent: () => {
		const { excalidrawAPI } = get()
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElements()
		excalidrawAPI.scrollToContent(elements, {
			fitToContent: true,
			animate: true,
			duration: 500,
		})
	},
}))

attachTestHooks()
