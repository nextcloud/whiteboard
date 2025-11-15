/**
 * SPDX-FileCopyrightText: 2020 Excalidraw
 * SPDX-License-Identifier: MIT
 */

import { getCommonBounds } from '@nextcloud/excalidraw'
import type { ExcalidrawElementsIncludingDeleted } from '@excalidraw/excalidraw/types/scene/Scene'

export function getViewportCenterPoint() {
	const x = window.innerWidth / 2
	const y = window.innerHeight / 2
	return { clientX: x, clientY: y }
}

export function moveElementsToViewport(
	elements: ExcalidrawElementsIncludingDeleted,
	targetCords: { x: number, y: number },
) {
	const [minx, maxx, miny, maxy] = getCommonBounds(elements)
	const centerx = Math.abs(minx - maxx) / 2
	const centery = Math.abs(miny - maxy) / 2
	return elements.map(element => {
		const x = element.x + (targetCords.x - centerx)
		const y = element.y + (targetCords.y - centery)
		return { ...element, x, y }
	})
}
