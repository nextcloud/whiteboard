/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'

interface WhiteboardStore {
	status: 'idle' | 'loading' | 'syncing'
	pendingSync: boolean
	setStatus: (status: 'idle' | 'loading' | 'syncing') => void
	setPendingSync: (pending: boolean) => void
}

export const useWhiteboardStore = create<WhiteboardStore>((set) => ({
	status: 'idle',
	pendingSync: false,
	setStatus: (status) => set({ status }),
	setPendingSync: (pending) => set({ pendingSync: pending }),
}))
