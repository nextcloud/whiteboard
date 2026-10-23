/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@nextcloud/excalidraw/types'

export type WorkerInboundMessage
	= { type: 'INIT' }
		| {
			type: 'SYNC_TO_LOCAL'
			fileId: number
			elements: readonly ExcalidrawElement[]
			files: BinaryFiles
			appState?: Partial<AppState>
			hasPendingLocalChanges: boolean
		}
		| {
			type: 'SYNC_TO_SERVER'
			fileId: number
			url: string
			jwt: string
			elements: readonly ExcalidrawElement[]
			files: BinaryFiles
			sceneKey: string
		}
		| { type: 'FLUSH', fileId: number, id: number, server: boolean }

export type WorkerOutboundMessage
	= { type: 'INIT_COMPLETE' }
		| { type: 'INIT_ERROR', error: string }
		| { type: 'LOCAL_SYNC_COMPLETE', duration: number, elementsCount: number }
		| { type: 'LOCAL_SYNC_ERROR', error: string }
		| { type: 'SERVER_SYNC_COMPLETE', duration: number, elementsCount: number, success: boolean, response?: unknown, fileId: number, sceneKey: string }
		| { type: 'SERVER_SYNC_ERROR', error: string }
		| { type: 'FLUSH_COMPLETE', id: number }

export type WorkerMessage = WorkerInboundMessage | WorkerOutboundMessage
