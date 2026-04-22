/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { newElementWith } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'

export function updateElementCustomData<T extends ExcalidrawElement>(
	element: T,
	updater: (currentCustomData: Record<string, unknown>) => Record<string, unknown>,
): T {
	const currentCustomData = (element.customData && typeof element.customData === 'object')
		? element.customData as Record<string, unknown>
		: {}

	return newElementWith(element, {
		customData: updater(currentCustomData),
	} as Partial<T>) as T
}
