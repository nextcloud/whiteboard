/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useCallback } from 'react'
import { useNetworkStore } from '../stores/networkStore'
import type { NetworkStatus } from '../stores/networkStore'

/**
 * Custom hook for network status management
 * Sets up listeners for online/offline events and provides methods to manage offline mode
 */
export const useNetwork = () => {
	// Get state and actions from the store
	const {
		status,
		isOfflineMode,
		setStatus,
		toggleOfflineMode,
		setOfflineMode,
	} = useNetworkStore()

	// Set up listeners for network status
	useEffect(() => {
		const handleOnline = () => {
			setStatus('online')
		}

		const handleOffline = () => {
			setStatus('offline')
			// Auto-enter offline mode when the network goes down
			setOfflineMode(true)
		}

		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)

		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
		}
	}, [setStatus, setOfflineMode])

	// Memoized toggle function
	const toggleOfflineModeCallback = useCallback(() => {
		toggleOfflineMode()
	}, [toggleOfflineMode])

	return {
		networkStatus: status,
		isOfflineMode,
		toggleOfflineMode: toggleOfflineModeCallback,
	}
}
