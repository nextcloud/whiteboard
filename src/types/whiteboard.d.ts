/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'

export interface ElementCreatorInfo {
	id: string
	name: string
	createdAt: number
}

export interface WhiteboardElement extends ExcalidrawElement {
	customData?: {
		creator?: ElementCreatorInfo
		lastModifiedBy?: ElementCreatorInfo
	}
}

export interface CreatorDisplaySettings {
	enabled: boolean
	displayMode: 'hover' | 'always' | 'selection'
	opacity: number
}
