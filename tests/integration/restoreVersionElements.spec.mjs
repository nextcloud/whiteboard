/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'

// Version changes as the editor makes them: one above the given version, with a new nonce
vi.mock('@nextcloud/excalidraw', () => ({
	restoreElements: (elements) => elements.map((element) => ({ ...element })),
	bumpVersion: (element, version) => Object.assign(element, { version: (version ?? element.version) + 1, versionNonce: element.versionNonce + 1000 }),
	newElementWith: (element, updates, force = false) => {
		if (!force && Object.entries(updates).every(([key, value]) => element[key] === value)) {
			return element
		}
		return { ...element, ...updates, version: element.version + 1, versionNonce: element.versionNonce + 1000 }
	},
}))

const { restoreVersionElements } = await import('../../src/utils/restoreVersionElements.ts')

const element = (id, version, { isDeleted = false, versionNonce = 100 + version } = {}) => ({ id, version, versionNonce, isDeleted })

describe('restoring a version', () => {
	it('brings back an element deleted after the version, above the deletion', () => {
		const [restored] = restoreVersionElements([element('image', 3)], [element('image', 4, { isDeleted: true })])

		expect(restored.isDeleted).toBe(false)
		expect(restored.version).toBeGreaterThan(4)
	})

	it('restores an element over the highest of its current copies', () => {
		const [restored] = restoreVersionElements(
			[{ ...element('text', 2), text: 'old' }],
			[{ ...element('text', 7), text: 'saved' }, { ...element('text', 9), text: 'local' }],
		)

		expect(restored.text).toBe('old')
		expect(restored.version).toBeGreaterThan(9)
	})

	it('restores an element over a concurrent copy with the same version', () => {
		const [restored] = restoreVersionElements([element('shape', 5, { versionNonce: 900 })], [element('shape', 5, { versionNonce: 100, isDeleted: true })])

		expect(restored.isDeleted).toBe(false)
		expect(restored.version).toBeGreaterThan(5)
	})

	it('restores an element over a copy that only differs in its deletion', () => {
		const [restored] = restoreVersionElements([element('comment', 5)], [element('comment', 5, { isDeleted: true })])

		expect(restored.isDeleted).toBe(false)
		expect(restored.version).toBeGreaterThan(5)
	})

	it('deletes an element added after the version, above its current copies', () => {
		const result = restoreVersionElements([element('kept', 1)], [element('kept', 1), element('added', 2), element('added', 3)])

		expect(result.find(({ id }) => id === 'added')).toMatchObject({ isDeleted: true, version: 4 })
		expect(result).toHaveLength(2)
	})

	it('gives elements deleted after the version a new deletion', () => {
		const [, removed] = restoreVersionElements([element('kept', 1)], [element('kept', 1), element('deleted', 6, { isDeleted: true })])

		expect(removed).toMatchObject({ id: 'deleted', isDeleted: true, version: 7 })
	})

	it('leaves elements unchanged since the version as they are', () => {
		const unchanged = element('unchanged', 5)

		expect(restoreVersionElements([unchanged], [element('unchanged', 5), element('unchanged', 5)])).toEqual([unchanged])
	})

	it('keeps elements that only the version has', () => {
		const purged = element('purged', 2)

		expect(restoreVersionElements([purged], [])).toEqual([purged])
	})
})
