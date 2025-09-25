/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { ElementCreatorInfo, WhiteboardElement } from '../types/whiteboard'

interface UseElementCreatorTrackingProps {
	excalidrawAPI: ExcalidrawImperativeAPI | null
	enabled?: boolean
}

export function useElementCreatorTracking({ excalidrawAPI }: UseElementCreatorTrackingProps) {

	// Get creator info for a specific element
	const getElementCreatorInfo = useCallback((elementId: string): ElementCreatorInfo | null => {
		if (!excalidrawAPI) return null

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as ExcalidrawElement[]
		const element = elements.find(el => el.id === elementId)

		return element?.customData?.creator || null
	}, [excalidrawAPI])

	// Get all unique creators in the current board
	const getAllCreators = useCallback((): Map<string, ElementCreatorInfo> => {
		if (!excalidrawAPI) return new Map()

		const creators = new Map<string, ElementCreatorInfo>()
		const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as WhiteboardElement[]

		elements.forEach(element => {
			if (element.customData?.creator) {
				creators.set(element.customData.creator.uid, element.customData.creator)
			}
			if (element.customData?.lastModifiedBy) {
				creators.set(element.customData.lastModifiedBy.uid, element.customData.lastModifiedBy)
			}
		})

		return creators
	}, [excalidrawAPI])

	return {
		getElementCreatorInfo,
		getAllCreators,
	}
}
