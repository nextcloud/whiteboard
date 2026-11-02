/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/types'

interface ExcalidrawStore {
	excalidrawAPI: ExcalidrawImperativeAPI | null

	setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
	resetExcalidrawAPI: () => void
	scrollToContent: () => void
}

export const useExcalidrawStore = create<ExcalidrawStore>((set, get) => ({
	excalidrawAPI: null,

	setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => set({ excalidrawAPI: api }),
	resetExcalidrawAPI: () => set({ excalidrawAPI: null }),
	scrollToContent: () => {
		const { excalidrawAPI } = get()
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElements()
		excalidrawAPI.setViewport({
			target: elements,
			animation: { duration: 500 },
		})
	},
}))

function attachTestHooks() {
	if (typeof window === 'undefined' || !window.__whiteboardTest) {
		return
	}

	window.__whiteboardTestHooks = window.__whiteboardTestHooks || {}
	;(window.__whiteboardTestHooks as Record<string, unknown>).excalidrawStore = useExcalidrawStore
}

attachTestHooks()
