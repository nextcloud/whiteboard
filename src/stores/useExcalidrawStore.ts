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

export const useExcalidrawStore = create<ExcalidrawStore>((set, get) => ({
	excalidrawAPI: null,

	setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => set({ excalidrawAPI: api }),
	resetExcalidrawAPI: () => set({ excalidrawAPI: null }),
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
