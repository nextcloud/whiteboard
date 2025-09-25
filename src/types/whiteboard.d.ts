/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement, ExcalidrawLinearElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
export interface ElementCreatorInfo {
	uid: string
	displayName: string
	createdAt: number
}

export type WhiteboardElement ={
	customData?: {
		creator?: ElementCreatorInfo
		lastModifiedBy?: ElementCreatorInfo
	},
} & ExcalidrawLinearElement & ExcalidrawElement

export interface CreatorDisplaySettings {
	enabled: boolean
	displayMode: 'hover' | 'always' | 'selection'
	opacity: number
}
