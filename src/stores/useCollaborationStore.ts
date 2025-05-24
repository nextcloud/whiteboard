/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import type { Socket } from 'socket.io-client'

export type CollaborationConnectionStatus = 'online' | 'offline' | 'connecting' | 'reconnecting'

interface CollaborationStore {
	status: CollaborationConnectionStatus
	socket: Socket | null
	isDedicatedSyncer: boolean // Is this client responsible for syncing to server/broadcasting?

	// Actions
	setStatus: (status: CollaborationConnectionStatus) => void
	setSocket: (socket: Socket | null) => void
	setDedicatedSyncer: (isSyncer: boolean) => void
	resetStore: () => void
}

const initialState: Omit<CollaborationStore, 'setStatus' | 'setSocket' | 'setDedicatedSyncer' | 'resetStore'> = {
	status: 'offline',
	socket: null,
	isDedicatedSyncer: false,
}

export const useCollaborationStore = create<CollaborationStore>()((set) => ({
	...initialState,

	setStatus: (status) => set((state) => (state.status === status ? {} : { status })),
	setSocket: (socket) => set({ socket }),
	setDedicatedSyncer: (isSyncer) => set({ isDedicatedSyncer: isSyncer }),
	resetStore: () => set(initialState),
}))
