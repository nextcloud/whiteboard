/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AppState {
	// UI State
	theme: 'light' | 'dark'
	viewModeEnabled: boolean

	// Actions
	setTheme: (theme: 'light' | 'dark') => void
	toggleTheme: () => void
	setViewModeEnabled: (enabled: boolean) => void
}

export const useAppStore = create<AppState>()(
	persist(
		(set) => ({
			theme: 'light', // Default theme
			viewModeEnabled: false,

			setTheme: (theme) => {
				set({ theme })
			},

			toggleTheme: () => {
				set((state) => ({
					theme: state.theme === 'light' ? 'dark' : 'light',
				}))
			},

			setViewModeEnabled: (enabled) => {
				set({ viewModeEnabled: enabled })
			},
		}),
		{
			name: 'app-storage',
			partialize: (state) => ({
				theme: state.theme,
			}),
		},
	),
)
