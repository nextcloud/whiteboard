/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import { createResolvablePromise } from '../utils/createResolvablePromise'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'

interface WhiteboardConfigState {
	// Core state
	fileId: number
	fileName: string
	publicSharingToken: string | null
	isReadOnly: boolean // Single source of truth for read-only state, determined by JWT
	isEmbedded: boolean
	initialDataPromise: ReturnType<typeof createResolvablePromise>
	collabBackendUrl: string // URL of the collaboration backend server
	isVersionPreview: boolean
	versionSource: string | null
	fileVersion: string | null

	// UI state
	zenModeEnabled: boolean
	gridModeEnabled: boolean

	// Core actions
	setConfig: (
		config: Partial<
			Pick<
				WhiteboardConfigState,
				| 'fileId'
				| 'fileName'
				| 'publicSharingToken'
				| 'isEmbedded'
				| 'collabBackendUrl'
				| 'isVersionPreview'
				| 'versionSource'
				| 'fileVersion'
			>
		>,
	) => void
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
export const useWhiteboardConfigStore = create<WhiteboardConfigState>()((set, get) => ({
	// Core state
	fileId: 0,
	fileName: '',
	publicSharingToken: null,
	isReadOnly: false,
	isEmbedded: false,
	initialDataPromise: createResolvablePromise(),
	collabBackendUrl: '', // Will be initialized from initial state
	isVersionPreview: false,
	versionSource: null,
	fileVersion: null,

	// UI state
	zenModeEnabled: false,
	gridModeEnabled: false,

	// Core actions
	setConfig: (config: Partial<Pick<WhiteboardConfigState,
		'fileId'
		| 'fileName'
		| 'publicSharingToken'
		| 'isEmbedded'
		| 'collabBackendUrl'
		| 'isVersionPreview'
		| 'versionSource'
		| 'fileVersion'
	>>) => {
		set(config)
	},

	resolveInitialData: (data: ExcalidrawInitialDataState) => {
		// Resolve the promise with the data
		get().initialDataPromise.resolve(data)
	},

	resetInitialDataPromise: () =>
		set({ initialDataPromise: createResolvablePromise() }),

	// Reset the entire store to its initial state
	resetStore: () => {
		// Keep the current fileId, fileName, and other config values
		const { fileId, fileName, publicSharingToken, isEmbedded, collabBackendUrl } = get()
		set({
			// Preserve these values
			fileId,
			fileName,
			publicSharingToken,
			isEmbedded,
			collabBackendUrl,
			isVersionPreview: false,
			versionSource: null,
			fileVersion: null,
			// Reset these values
			isReadOnly: false,
			initialDataPromise: createResolvablePromise(),
			zenModeEnabled: false,
			gridModeEnabled: false,
		})
	},

	// UI actions
	setZenModeEnabled: (enabled: boolean) => set({ zenModeEnabled: enabled }),

	setGridModeEnabled: (enabled: boolean) => set({ gridModeEnabled: enabled }),

	// Permission actions
	setReadOnly: (readOnly: boolean) => {
		if (get().isVersionPreview) {
			set({ isReadOnly: true })
			return
		}
		set({ isReadOnly: readOnly })
	},
}))
