/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const { reconcileElements, restoreElements } = await import('@nextcloud/excalidraw')
const { readAnswer } = await import('../../src/sync/answer.ts')
const { BOARD_SETTINGS } = await import('../../src/sync/changes.ts')
const { SCENE_SCHEMA_VERSION } = await import('../../src/sync/roomMessages.ts')
const { inIndexOrder, sameStamp, wins, withIntegerStamps } = await import('../../src/sync/elementOrder.ts')

// What Nextcloud's tests check on their side too (tests/Unit/Controller, tests/Unit/Service/WhiteboardContentServiceTest.php)
const contract = JSON.parse(readFileSync('tests/fixtures/board-sync-contract.json', 'utf8'))

describe('the contract with Nextcloud', () => {
	it('saves with the schema version Nextcloud takes', () => {
		expect(SCENE_SCHEMA_VERSION).toBe(contract.schemaVersion)
	})

	it('keeps the board settings Nextcloud saves', () => {
		expect([...BOARD_SETTINGS]).toEqual(contract.boardSettings)
	})

	it.each(Object.entries(contract.answers))('reads the %s answer', (name, { status, code }) => {
		const sync = { epoch: 'e1', rev: 1 }
		const meaning = {
			replaced: { kind: 'replaced', sync },
			unreadable: { kind: 'unreadable', sync },
			behind: { kind: 'behind', sync },
			busy: { kind: 'busy' },
			upgrade: { kind: 'refused', reason: 'upgrade' },
			forbidden: { kind: 'refused', reason: 'forbidden' },
			gone: { kind: 'refused', reason: 'gone' },
		}
		expect(readAnswer({ status, body: { ...(code ? { code } : {}), ...(status === 409 ? { sync } : {}) } })).toEqual(meaning[name])
	})

	it.each(contract.order)('orders the elements of a board as Nextcloud does: %o', ({ elements, ids }) => {
		expect(inIndexOrder(elements).map((element) => element.id)).toEqual(ids)
	})

	it.each(contract.wins)('orders copies as Nextcloud does: %o', ({ copy, stored, wins: expected }) => {
		expect(wins(copy, stored)).toBe(expected)
	})

	describe('with the Excalidraw the editor runs', () => {
		const rectangle = (fields) => ({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, ...fields })
		// A copy of element `a` as the editor shows it: stamps read as from Nextcloud, then restored
		const shown = (stamps, x) => restoreElements([withIntegerStamps(rectangle({ id: 'a', index: 'a0', x, ...stamps }))], null)[0]
		// Whether the editor takes `copy` into a scene that shows `stored`
		const takes = (copy, stored, appState = {}) => reconcileElements([shown(stored, 1)], [shown(copy, 2)], appState)[0].x === 2

		it.each(contract.wins)('takes a copy into the scene as Nextcloud orders copies: %o', ({ copy, stored, wins: expected }) => {
			expect(takes(copy, stored)).toBe(expected)
		})

		it.each(['editingTextElement', 'resizingElement', 'newElement'])('keeps the copy of an element in appState.%s, which the engine shows later', (key) => {
			expect(takes({ version: 9, versionNonce: 1 }, { version: 1, versionNonce: 1 }, { [key]: { id: 'a' } })).toBe(false)
		})

		it.each(contract.order)('restores and reconciles the elements of a board in the order Nextcloud keeps: %o', ({ elements, ids }) => {
			const restored = restoreElements(inIndexOrder(elements.map(rectangle)), null)

			expect(restored.map((element) => element.id)).toEqual(ids)
			expect(reconcileElements([], restored, {}).map((element) => element.id)).toEqual(ids)
		})
	})

	it.each(contract.stamps)('reads the stamps of a board as Nextcloud does: %o', ({ element, stamps }) => {
		const changes = { elements: [{ id: 'a', type: 'rectangle', ...element }], files: {} }
		const answer = readAnswer({ status: 200, body: { sync: { epoch: 'e1', rev: 1 }, data: changes, delta: changes } })
		const stampsOf = ({ version, versionNonce }) => ({ version, versionNonce })

		expect(stampsOf(answer.data.elements[0])).toEqual(stamps)
		expect(stampsOf(answer.delta.elements[0])).toEqual(stamps)
	})

	// Boards written by other tools may carry stamps that are not integers, which Nextcloud reads as the client does
	it.each([
		...contract.wins.map(({ copy, stored }) => [copy, stored]),
		[{ version: 1.5, versionNonce: 'a' }, { version: 'b' }],
		[{ version: '2', versionNonce: 3 }, { version: 0, versionNonce: 3 }],
	])('tells for every pair of copies that one wins or that they have the same stamp: %o %o', (a, b) => {
		expect([wins(a, b), wins(b, a), sameStamp(a, b)].filter(Boolean)).toHaveLength(1)
	})
})
