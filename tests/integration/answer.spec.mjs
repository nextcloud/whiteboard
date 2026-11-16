/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'

const { readAnswer } = await import('../../src/sync/answer.ts')

const sync = { epoch: 'e1', rev: 3 }

describe('readAnswer', () => {
	it.each([
		['the board', { status: 200, body: { sync, data: { elements: [], files: {} } } }, { kind: 'ok', sync, data: { elements: [], files: {} } }],
		['what changed', { status: 200, body: { sync, delta: { elements: [], files: {} } } }, { kind: 'ok', sync, delta: { elements: [], files: {} } }],
		['a page that is not the board API', { status: 200, body: null }, { kind: 'failed' }],
		['a 409 of another kind', { status: 409, body: { code: 'board_locked', sync } }, { kind: 'failed' }],
		['a 400 of another kind', { status: 400, body: { message: 'Invalid user' } }, { kind: 'failed' }],
		['a token Nextcloud refuses', { status: 401, body: { message: 'Unauthorized' } }, { kind: 'failed', reason: 'unauthorized' }],
		['a save too large for the web server', { status: 413, body: null }, { kind: 'failed', reason: 'tooLarge' }],
		['a server error', { status: 500, body: { message: 'An error occurred' } }, { kind: 'failed' }],
		['no answer', null, { kind: 'failed' }],
	])('reads %s', (_, response, answer) => {
		expect(readAnswer(response)).toEqual(answer)
	})
})
