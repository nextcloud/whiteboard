/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types'

export type WorkerInboundMessage =
	| { type: 'INIT' }
	| {
		type: 'SYNC_TO_LOCAL'
		fileId: number
		elements: readonly ExcalidrawElement[]
		files: BinaryFiles
		appState?: Partial<AppState>
	}
	| {
		type: 'SYNC_TO_SERVER'
		fileId: number
		url: string
		jwt: string
		elements: readonly ExcalidrawElement[]
		files: BinaryFiles
	}

export type WorkerOutboundMessage =
	| { type: 'INIT_COMPLETE' }
	| { type: 'INIT_ERROR'; error: string }
	| { type: 'LOCAL_SYNC_COMPLETE'; duration: number; elementsCount: number }
	| { type: 'LOCAL_SYNC_ERROR'; error: string }
	| { type: 'SERVER_SYNC_COMPLETE'; duration: number; elementsCount: number; success: boolean; response?: unknown; skipped?: boolean }
	| { type: 'SERVER_SYNC_ERROR'; error: string }

export type WorkerMessage = WorkerInboundMessage | WorkerOutboundMessage
