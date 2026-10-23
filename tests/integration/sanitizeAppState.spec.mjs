/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { sanitizeAppStateForSync } from '../../src/utils/sanitizeAppState.ts'

describe('sanitizeAppStateForSync', () => {
	it('drops the open context menu, whose actions cannot be posted to the sync worker', () => {
		const appState = {
			viewBackgroundColor: '#ffffff',
			contextMenu: { top: 10, left: 10, items: [{ name: 'copy', perform: () => {} }] },
		}

		const sanitized = sanitizeAppStateForSync(appState)

		expect(sanitized).toEqual({ viewBackgroundColor: '#ffffff' })
		expect(() => structuredClone(sanitized)).not.toThrow()
		expect(appState.contextMenu).toBeDefined()
	})

	it('drops the search matches that Whiteboard 2.x stored locally', () => {
		const stored = { theme: 'dark', currentItemFontFamily: 3, searchMatches: [] }

		expect(sanitizeAppStateForSync(stored)).toEqual({ theme: 'dark', currentItemFontFamily: 3 })
	})

	it('drops per-client state', () => {
		const stored = { theme: 'light', collaborators: new Map(), selectedElementIds: { a: true }, width: 100, height: 50 }

		expect(sanitizeAppStateForSync(stored)).toEqual({ theme: 'light' })
	})
})
