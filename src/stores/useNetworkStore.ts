/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import type { Collaborator } from '../types'

export type ConnectionStatus = 'online' | 'offline' | 'connecting' | 'reconnecting'

interface NetworkStore {
	// Connection state
	status: ConnectionStatus
	lastConnected: number | null
	reconnectAttempts: number
	collaborators: Map<string, Collaborator>

	// Actions
	setStatus: (status: ConnectionStatus) => void
	setLastConnected: (timestamp: number | null) => void
	incrementReconnectAttempts: () => void
	resetReconnectAttempts: () => void
	setCollaborators: (collaborators: Map<string, Collaborator>) => void
	clearCollaborators: () => void
}

export const useNetworkStore = create<NetworkStore>()((set) => ({
	// Connection state
	status: 'offline',
	lastConnected: null,
	reconnectAttempts: 0,
	collaborators: new Map(),

	// Actions
	setStatus: (status) => {
		set({ status })

		// When going offline, clear collaborators
		if (status === 'offline') {
			set({ collaborators: new Map() })
		}
	},

	setLastConnected: (timestamp) => {
		set({ lastConnected: timestamp })
	},

	incrementReconnectAttempts: () => {
		set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 }))
	},

	resetReconnectAttempts: () => {
		set({ reconnectAttempts: 0 })
	},

	setCollaborators: (collaborators) => {
		set({ collaborators })
	},

	clearCollaborators: () => {
		set({ collaborators: new Map() })
	},
}))
