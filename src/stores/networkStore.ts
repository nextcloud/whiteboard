/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type NetworkStatus = 'online' | 'offline'

interface NetworkState {
	// Status
	status: NetworkStatus
	isOfflineMode: boolean

	// Actions
	setStatus: (status: NetworkStatus) => void
	toggleOfflineMode: () => void
	setOfflineMode: (isOffline: boolean) => void
}

export const useNetworkStore = create<NetworkState>()(
	persist(
		(set) => ({
			status: navigator.onLine ? 'online' : 'offline',
			isOfflineMode: false,

			setStatus: (status) => {
				set({ status })
			},

			toggleOfflineMode: () => {
				set((state) => ({ isOfflineMode: !state.isOfflineMode }))
			},

			setOfflineMode: (isOffline) => {
				set({ isOfflineMode: isOffline })
			},
		}),
		{
			name: 'network-storage',
			partialize: (state) => ({ isOfflineMode: state.isOfflineMode }),
		},
	),
)
