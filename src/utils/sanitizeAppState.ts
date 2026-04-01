/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AppState } from '@excalidraw/excalidraw/types/types'

const NON_TRANSFERRED_KEYS = [
	'collaborators',
	'selectedElementIds',
	'width',
	'height',
	'offsetTop',
	'offsetLeft',
] as const

export function sanitizeAppStateForSync(state: Partial<AppState> | AppState | null | undefined): Partial<AppState> {
	if (!state || typeof state !== 'object') {
		return {}
	}

	const cleaned = { ...state } as Partial<AppState> & { scrollToContent?: boolean }

	NON_TRANSFERRED_KEYS.forEach((key) => {
		delete (cleaned as Record<string, unknown>)[key]
	})
	delete cleaned.scrollToContent

	return cleaned
}
