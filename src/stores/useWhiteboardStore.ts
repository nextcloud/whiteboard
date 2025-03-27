/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { db } from '../database/db'
import { useSyncStore } from './useSyncStore'
import { throttle } from 'lodash'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import type {
	BinaryFiles,
	AppState,
	ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types/types'
import { resolvablePromise } from '../utils'

interface WhiteboardSocket {
  id: string
  on: (event: string, callback: (...args: unknown[]) => void) => void
  off: (event: string) => void
  emit: (event: string, ...args: unknown[]) => void
}

const initialDataState: ExcalidrawInitialDataState = {
	elements: [],
	appState: {
		currentItemFontFamily: 3,
		currentItemStrokeWidth: 1,
		currentItemRoughness: 0,
	},
	files: {},
}

interface WhiteboardState {
  // Configuration
  fileId: number
  fileName: string
  publicSharingToken: string | null
  isReadOnly: boolean
  isEmbedded: boolean

  // Data state
  isInitialized: boolean
  initialDataPromise: ResolvablePromise<ExcalidrawInitialDataState>
  isDedicatedSyncer: boolean
  socketRef: WhiteboardSocket | null

  // Configuration actions
  setConfig: (
    config: Partial<Pick<WhiteboardState, 'fileId' | 'fileName' | 'publicSharingToken' | 'isReadOnly' | 'isEmbedded'>>
  ) => void

  // Data actions
  initializeData: () => void
  saveToLocalStorage: (
    elements: ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void
  saveBeforeUnload: () => void
  setSocketRef: (socket: WhiteboardSocket) => void
  setReadOnly: (readOnly: boolean) => void
  setDedicatedSyncer: (isSyncer: boolean) => void
}

export const useWhiteboardStore = create<WhiteboardState>(
	(set, get) => {
		const throttledSaveToLocalStorage = throttle(
			async (
				elements: ExcalidrawElement[],
				appState: AppState,
				files: BinaryFiles,
			) => {
				const { fileId } = get()

				if (!fileId || !elements) {
					console.error(
						'[WhiteboardStore] Missing required data for local save',
						{ fileId, elementsCount: elements?.length },
					)
					return
				}

				try {
					console.log(
						`[WhiteboardStore] Saving ${elements.length} elements to local storage via sync store`,
					)

					const filteredAppState = { ...appState }
					if (filteredAppState?.collaborators) {
						delete filteredAppState?.collaborators
					}

					useSyncStore
						.getState()
						.syncToLocal(elements, files, filteredAppState)

					return { success: true }
				} catch (error) {
					console.error(
						'[WhiteboardStore] Error saving to local storage:',
						error,
					)
					return { success: false, error }
				}
			},
			3000,
			{
				leading: false,
				trailing: true,
			},
		)

		return {
			// Configuration state
			fileId: 0,
			fileName: '',
			publicSharingToken: null,
			isReadOnly: false,
			isEmbedded: false,

			// Data state
			isInitialized: false,
			initialDataPromise: resolvablePromise(),
			isDedicatedSyncer: false,
			socketRef: null,

			// Configuration actions
			setConfig: (config) => {
				console.log('[WhiteboardStore] Setting config:', config)
				set(config)
			},

			// Data actions
			setSocketRef: (socket) => {
				set({ socketRef: socket })
			},

			setReadOnly: (readOnly) => {
				set({ isReadOnly: readOnly })
			},

			setDedicatedSyncer: (isSyncer) => {
				set({ isDedicatedSyncer: isSyncer })
				console.log(
					`[Sync] ${isSyncer ? 'DESIGNATED as syncer' : 'NOT designated as syncer'}`,
				)
			},

			initializeData: async () => {
				const { fileId } = get()

				console.log(
					'[WhiteboardStore] Initializing data for file:',
					fileId,
				)

				try {
					useSyncStore.getState().initialize()

					const localData = await db.get(fileId)

					if (
						localData
            && localData.elements
            && localData.elements.length > 0
					) {
						console.log(
							`[WhiteboardStore] Found ${localData.elements.length} elements in local storage`,
						)

						get().initialDataPromise.resolve({
							elements: localData.elements,
							appState: {
								...initialDataState.appState,
								...localData.appState,
							},
							files: localData.files || {},
						})
					} else {
						console.log(
							'[WhiteboardStore] No data found in local storage, using initial state',
						)

						get().initialDataPromise.resolve(initialDataState)
					}

					set({ isInitialized: true })
				} catch (error) {
					console.error(
						'[WhiteboardStore] Error initializing data:',
						error,
					)

					get().initialDataPromise.resolve(initialDataState)
				}
			},

			saveToLocalStorage: (
				elements: ExcalidrawElement[],
				appState: AppState,
				files: BinaryFiles,
			) => {
				return throttledSaveToLocalStorage(elements, appState, files)
			},

			saveBeforeUnload: () => {
				console.log('[WhiteboardStore] Saving data before unload')

				throttledSaveToLocalStorage.flush()
			},
		}
	},
)

document.addEventListener('whiteboard-socket-ready', ((event: CustomEvent) => {
	const socket = event.detail as WhiteboardSocket
	const whiteboardStore = useWhiteboardStore.getState()

	console.log(
		'[WhiteboardStore] Received socket from collaboration module',
	)
	whiteboardStore.setSocketRef(socket)

	socket.on('read-only', () => {
		whiteboardStore.setReadOnly(true)
		console.log('[Permissions] User has read-only access')
	})

	socket.on('sync-designate', (data: { isSyncer: boolean }) => {
		whiteboardStore.setDedicatedSyncer(data.isSyncer)
	})
}) as EventListener)

window.addEventListener('beforeunload', () => {
	useWhiteboardStore.getState().saveBeforeUnload()
})
