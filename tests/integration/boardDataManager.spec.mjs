/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { getLocalBoardDataPolicy } from '../../src/utils/localBoardData.ts'

describe('local board data policy', () => {
	it.each([
		['ignores pending local changes for read-only users', true, true, true, true, 'ignore'],
		['ignores local fallback for offline read-only users', false, true, true, true, 'ignore'],
		['reconciles pending changes for writable users', true, true, true, false, 'reconcile'],
		['uses local fallback for offline writable users', false, true, true, false, 'fallback'],
		['uses server data when writable local data is clean', true, true, false, false, 'ignore'],
	])('%s', (_case, hasServerData, hasLocalData, hasPendingLocalChanges, isReadOnly, expected) => {
		expect(getLocalBoardDataPolicy(
			hasServerData,
			hasLocalData,
			hasPendingLocalChanges,
			isReadOnly,
		)).toBe(expected)
	})
})
