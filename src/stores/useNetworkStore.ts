/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'

export type ConnectionStatus = 'online' | 'offline' | 'connecting'

interface NetworkStore {
	status: ConnectionStatus

	setStatus: (status: ConnectionStatus) => void
}

export const useNetworkStore = create<NetworkStore>()((set) => ({
	status: 'offline',

	setStatus: (status) => {
		set({ status })
	},
}))
