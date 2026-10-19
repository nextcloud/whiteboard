/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveOrgLibraryItems } from '../../src/utils/orgLibraryItems.ts'

const resolved = async (scope, name) => [{ id: `${scope}:${name}:1`, libraryName: name }]

describe('organization library items', () => {
	it('resolves every organization library', async () => {
		const resolveLibrary = vi.fn(resolved)

		const items = await resolveOrgLibraryItems(
			[{ name: 'Shapes', itemCount: 1 }, { name: 'Icons', itemCount: 1 }],
			null,
			resolveLibrary,
		)

		expect(items.map(({ id }) => id)).toEqual(['org:Shapes:1', 'org:Icons:1'])
		expect(resolveLibrary).toHaveBeenCalledTimes(2)
	})

	it('skips the organization library the board already references', async () => {
		const resolveLibrary = vi.fn(resolved)

		const items = await resolveOrgLibraryItems(
			[{ name: 'Shapes', itemCount: 1 }, { name: 'Icons', itemCount: 1 }],
			{ scope: 'org', name: 'Shapes' },
			resolveLibrary,
		)

		expect(items.map(({ id }) => id)).toEqual(['org:Icons:1'])
		expect(resolveLibrary).toHaveBeenCalledOnce()
	})

	it('keeps an organization library when the board references a personal one with the same name', async () => {
		const items = await resolveOrgLibraryItems(
			[{ name: 'Shapes', itemCount: 1 }],
			{ scope: 'personal', name: 'Shapes' },
			resolved,
		)

		expect(items.map(({ id }) => id)).toEqual(['org:Shapes:1'])
	})

	it('keeps the other libraries when one fails to resolve', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

		const items = await resolveOrgLibraryItems(
			[{ name: 'Broken', itemCount: 1 }, { name: 'Icons', itemCount: 1 }],
			null,
			async (scope, name) => {
				if (name === 'Broken') {
					throw new Error('Failed to resolve library')
				}
				return resolved(scope, name)
			},
		)

		expect(items.map(({ id }) => id)).toEqual(['org:Icons:1'])
		expect(consoleError).toHaveBeenCalledOnce()
		consoleError.mockRestore()
	})
})
