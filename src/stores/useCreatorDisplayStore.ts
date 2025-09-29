/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { CreatorDisplaySettings } from '../types/whiteboard'

interface CreatorDisplayStore {
	settings: CreatorDisplaySettings
	setEnabled: (enabled: boolean) => void
	setDisplayMode: (mode: 'hover' | 'always' | 'selection') => void
	setOpacity: (opacity: number) => void
	updateSettings: (settings: Partial<CreatorDisplaySettings>) => void
}

const defaultSettings: CreatorDisplaySettings = {
	enabled: false,
	displayMode: 'hover',
	opacity: 0.7,
}

export const useCreatorDisplayStore = create<CreatorDisplayStore>()(
	persist(
		(set) => ({
			settings: defaultSettings,

			setEnabled: (enabled) => set((state) => ({
				settings: { ...state.settings, enabled },
			})),

			setDisplayMode: (displayMode) => set((state) => ({
				settings: { ...state.settings, displayMode },
			})),

			setOpacity: (opacity) => set((state) => ({
				settings: { ...state.settings, opacity },
			})),

			updateSettings: (newSettings) => set((state) => ({
				settings: { ...state.settings, ...newSettings },
			})),
		}),
		{
			name: 'creator-display-settings',
			storage: createJSONStorage(() => localStorage),
		},
	),
)
