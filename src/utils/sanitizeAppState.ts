/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AppState } from '@excalidraw/excalidraw/types/types'

const NON_TRANSFERRED_KEYS: Array<keyof AppState> = [
	'collaborators',
	'selectedElementIds',
	'width',
	'height',
	'offsetTop',
	'offsetLeft',
]

export function sanitizeAppStateForSync(state: Partial<AppState> | AppState | null | undefined): Partial<AppState> {
	if (!state || typeof state !== 'object') {
		return {}
	}

	const cleaned: Partial<AppState> = { ...state }

	NON_TRANSFERRED_KEYS.forEach((key) => {
		delete (cleaned as Record<string, unknown>)[key]
	})

	return cleaned
}
