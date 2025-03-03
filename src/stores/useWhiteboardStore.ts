/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { resolvablePromise } from '../utils'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'

interface WhiteboardState {
	// Core state
	fileId: number
	fileName: string
	publicSharingToken: string | null
	isReadOnly: boolean // Single source of truth for read-only state, determined by JWT
	isEmbedded: boolean
	initialDataPromise: ReturnType<typeof resolvablePromise>
	isInitializing: boolean // Indicates if the app is still initializing data
	collabBackendUrl: string // URL of the collaboration backend server

	// UI state
	zenModeEnabled: boolean
	gridModeEnabled: boolean

	// Core actions
	setConfig: (
		config: Partial<
			Pick<
				WhiteboardState,
				| 'fileId'
				| 'fileName'
				| 'publicSharingToken'
				| 'isEmbedded'
				| 'collabBackendUrl'
			>
		>,
	) => void
	setIsInitializing: (initializing: boolean) => void
	resolveInitialData: (data: ExcalidrawInitialDataState) => void
	resetInitialDataPromise: () => void
	resetStore: () => void // Reset the entire store state

	// UI actions
	setZenModeEnabled: (enabled: boolean) => void
	setGridModeEnabled: (enabled: boolean) => void

	// Permission actions
	setReadOnly: (readOnly: boolean) => void
}

// Create the store without persistence
export const useWhiteboardStore = create<WhiteboardState>()((set, get) => ({
	// Core state
	fileId: 0,
	fileName: '',
	publicSharingToken: null,
	isReadOnly: false,
	isEmbedded: false,
	initialDataPromise: resolvablePromise(),
	isInitializing: true, // Start in initializing state
	collabBackendUrl: '', // Will be initialized from initial state

	// UI state
	zenModeEnabled: false,
	gridModeEnabled: false,

	// Core actions
	setConfig: (config: Partial<Pick<WhiteboardState, 'fileId' | 'fileName' | 'publicSharingToken' | 'isEmbedded' | 'collabBackendUrl'>>) => {
		set(config)
	},

	setIsInitializing: (initializing: boolean) => {
		set({ isInitializing: initializing })
		console.log(`[WhiteboardStore] Initializing state set to: ${initializing}`)
	},

	resolveInitialData: (data: ExcalidrawInitialDataState) => {
		console.log('[WhiteboardStore] Resolving initial data:', {
			elementCount: data.elements ? data.elements.length : 0,
			firstElement: data.elements && data.elements.length > 0 ? data.elements[0].type : 'none',
			hasFiles: !!data.files && Object.keys(data.files).length > 0,
			hasAppState: !!data.appState,
		})

		// Resolve the promise with the data
		get().initialDataPromise.resolve(data)
		console.log('[WhiteboardStore] Initial data loaded and resolved')
	},

	resetInitialDataPromise: () =>
		set({ initialDataPromise: resolvablePromise() }),

	// Reset the entire store to its initial state
	resetStore: () => {
		console.log('[WhiteboardStore] Resetting store state')
		// Keep the current fileId, fileName, and other config values
		const { fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl } = get()
		set({
			// Preserve these values
			fileId,
			fileName,
			publicSharingToken,
			isEmbedded,
			collabBackendUrl,
			// Reset these values
			isReadOnly: false,
			initialDataPromise: resolvablePromise(),
			isInitializing: true,
			zenModeEnabled: false,
			gridModeEnabled: false,
		})
	},

	// UI actions
	setZenModeEnabled: (enabled: boolean) => set({ zenModeEnabled: enabled }),

	setGridModeEnabled: (enabled: boolean) => set({ gridModeEnabled: enabled }),

	// Permission actions
	setReadOnly: (readOnly: boolean) => {
		set({ isReadOnly: readOnly })
		console.log(`[WhiteboardStore] Read-only state set to: ${readOnly}`)
	},
}))
