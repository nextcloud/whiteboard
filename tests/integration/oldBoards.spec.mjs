// @vitest-environment jsdom
/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { restoreElements } from '@nextcloud/excalidraw'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe.each(['1.5.9', '2.0.0'])('board saved by Whiteboard %s', (version) => {
	const board = JSON.parse(readFileSync(`tests/fixtures/boards/saved-by-${version}.whiteboard`, 'utf8'))
	const stored = board.elements.filter((element) => !element.isDeleted)
	const restored = new Map(restoreElements(board.elements, null).map((element) => [element.id, element]))

	it('keeps every element version, version nonce and customData when restored', () => {
		for (const element of stored) {
			expect(restored.get(element.id)).toMatchObject({
				version: element.version,
				versionNonce: element.versionNonce,
				customData: element.customData,
			})
		}
	})

	it('keeps bound text, arrow bindings and image file ids when restored', () => {
		const text = stored.find((element) => element.type === 'text')
		const arrow = stored.find((element) => element.type === 'arrow')
		const image = stored.find((element) => element.type === 'image')

		expect(restored.get(text.id).containerId).toBe(text.containerId)
		expect(restored.get(arrow.id).startBinding.elementId).toBe(arrow.startBinding.elementId)
		expect(restored.get(arrow.id).endBinding.elementId).toBe(arrow.endBinding.elementId)
		expect(restored.get(image.id).fileId).toBe(image.fileId)
		expect(board.files[image.fileId]).toBeDefined()
	})
})

// The engine tests stand in for this rule of Excalidraw (tests/integration/boardSync.spec.mjs): an element out of index order gets a later index and a new version
describe('restoring elements out of index order', () => {
	it('gives the later element a later index and a higher version', () => {
		const box = (id, index) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, index, version: 3, versionNonce: 7 })

		const [first, second] = restoreElements([box('a', 'a2'), box('b', 'a1')], null)

		expect(first).toMatchObject({ id: 'a', index: 'a2', version: 3 })
		expect(second.index > first.index).toBe(true)
		expect(second.version).toBeGreaterThan(3)
	})
})
