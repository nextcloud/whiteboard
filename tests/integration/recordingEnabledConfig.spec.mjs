/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('RECORDING_ENABLED', () => {
	const loadConfig = async () => (await import('../../websocket_server/Utilities/ConfigUtility.js')).default

	beforeEach(() => {
		vi.resetModules()
		delete process.env.RECORDING_ENABLED
	})

	afterEach(() => {
		delete process.env.RECORDING_ENABLED
	})

	it('keeps recording on when it is not set', async () => {
		expect((await loadConfig()).RECORDING_ENABLED).toBe(true)
	})

	it('turns recording off with false', async () => {
		process.env.RECORDING_ENABLED = 'false'

		expect((await loadConfig()).RECORDING_ENABLED).toBe(false)
	})
})
