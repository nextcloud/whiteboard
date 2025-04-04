/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { Socket } from 'socket.io-client'
import { create } from 'zustand'
import { resolvablePromise } from '../utils'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'

export type AppStatus = 'loading' | 'ready'

interface WhiteboardState {
	// Core state
	fileId: number
	fileName: string
	publicSharingToken: string | null
	isReadOnly: boolean
	isEmbedded: boolean
	appStatus: AppStatus
	initialDataPromise: ReturnType<typeof resolvablePromise>
	initialDataLoaded: boolean

	// UI state
	viewModeEnabled: boolean
	zenModeEnabled: boolean
	gridModeEnabled: boolean

	// Socket state
	socketRef: Socket | null
	isDedicatedSyncer: boolean

	// Core actions
	setConfig: (
		config: Partial<
			Pick<
				WhiteboardState,
				| 'fileId'
				| 'fileName'
				| 'publicSharingToken'
				| 'isReadOnly'
				| 'isEmbedded'
			>
		>,
	) => void
	setAppStatus: (status: AppStatus) => void
	resolveInitialData: (data: ExcalidrawInitialDataState) => void
	resetInitialDataPromise: () => void

	// UI actions
	setViewModeEnabled: (enabled: boolean) => void
	setZenModeEnabled: (enabled: boolean) => void
	setGridModeEnabled: (enabled: boolean) => void

	// Socket actions
	setSocketRef: (socket: Socket) => void
	setReadOnly: (readOnly: boolean) => void
	setDedicatedSyncer: (isSyncer: boolean) => void
}

export const useWhiteboardStore = create<WhiteboardState>((set, get) => ({
	// Core state
	fileId: 0,
	fileName: '',
	publicSharingToken: null,
	isReadOnly: false,
	isEmbedded: false,
	appStatus: 'loading',
	initialDataPromise: resolvablePromise(),
	initialDataLoaded: false,

	// UI state
	viewModeEnabled: false,
	zenModeEnabled: false,
	gridModeEnabled: false,

	// Socket state
	socketRef: null,
	isDedicatedSyncer: false,

	// Core actions
	setConfig: (config) => {
		set((state) => {
			const newState = { ...config } as Partial<WhiteboardState>

			// If embedded mode is being set and view mode is not already enabled, set view mode
			if (config.isEmbedded !== undefined && config.isEmbedded && state.viewModeEnabled === false) {
				newState.viewModeEnabled = true
			}

			// If read-only is being set to true, also enable view mode
			if (config.isReadOnly !== undefined && config.isReadOnly && state.viewModeEnabled === false) {
				newState.viewModeEnabled = true
			}

			return newState
		})
	},

	setAppStatus: (status) => set({ appStatus: status }),

	resolveInitialData: (data) => {
		console.log('[WhiteboardStore] Resolving initial data:', {
			elementCount: data.elements ? data.elements.length : 0,
			firstElement: data.elements && data.elements.length > 0 ? data.elements[0].type : 'none',
			hasFiles: !!data.files && Object.keys(data.files).length > 0,
			hasAppState: !!data.appState,
		})

		// Resolve the promise with the data
		get().initialDataPromise.resolve(data)

		// Mark initial data as loaded
		set({ initialDataLoaded: true })
		console.log('[WhiteboardStore] Initial data loaded and resolved')
	},

	resetInitialDataPromise: () =>
		set({ initialDataPromise: resolvablePromise(), initialDataLoaded: false }),

	// UI actions
	setViewModeEnabled: (enabled) => set({ viewModeEnabled: enabled }),

	setZenModeEnabled: (enabled) => set({ zenModeEnabled: enabled }),

	setGridModeEnabled: (enabled) => set({ gridModeEnabled: enabled }),

	// Socket actions
	setSocketRef: (socket) => set({ socketRef: socket }),

	setReadOnly: (readOnly) => {
		set((state) => {
			// If setting to read-only, also enable view mode
			if (readOnly && !state.viewModeEnabled) {
				return { isReadOnly: readOnly, viewModeEnabled: true }
			}
			return { isReadOnly: readOnly }
		})
	},

	setDedicatedSyncer: (isSyncer) => set({ isDedicatedSyncer: isSyncer }),
}))
