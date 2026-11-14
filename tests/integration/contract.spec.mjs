/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const { readAnswer } = await import('../../src/sync/answer.ts')
const { BOARD_SETTINGS } = await import('../../src/sync/changes.ts')
const { SCENE_SCHEMA_VERSION } = await import('../../src/sync/roomMessages.ts')
const { inIndexOrder, sameStamp, wins } = await import('../../src/sync/elementOrder.ts')

// What Nextcloud's tests check on their side too (tests/Unit/Controller, tests/Unit/Service/WhiteboardContentServiceTest.php)
const contract = JSON.parse(readFileSync(new URL('../fixtures/board-sync-contract.json', import.meta.url), 'utf8'))

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

	// Boards written by other tools may carry stamps that are not integers, which Nextcloud counts as 0
	it.each([
		...contract.wins.map(({ copy, stored }) => [copy, stored]),
		[{ version: 1.5, versionNonce: 'a' }, { version: 'b' }],
		[{ version: '2', versionNonce: 3 }, { version: 0, versionNonce: 3 }],
	])('tells for every pair of copies that one wins or that they have the same stamp: %o %o', (a, b) => {
		expect([wins(a, b), wins(b, a), sameStamp(a, b)].filter(Boolean)).toHaveLength(1)
	})
})
