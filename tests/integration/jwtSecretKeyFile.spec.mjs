/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('JWT_SECRET_KEY_FILE', () => {
	const dir = mkdtempSync(join(tmpdir(), 'whiteboard-secret-'))
	const secretFile = (content) => {
		const path = join(dir, `secret-${Math.random()}`)
		writeFileSync(path, content)
		return path
	}
	const loadConfig = async () => (await import('../../websocket_server/Utilities/ConfigUtility.js')).default

	beforeEach(() => {
		vi.resetModules()
		delete process.env.JWT_SECRET_KEY
		delete process.env.JWT_SECRET_KEY_FILE
	})

	afterEach(() => {
		delete process.env.JWT_SECRET_KEY
		delete process.env.JWT_SECRET_KEY_FILE
	})

	it('reads the secret from the file without the trailing newline', async () => {
		process.env.JWT_SECRET_KEY_FILE = secretFile('s3cret\n')

		expect((await loadConfig()).JWT_SECRET_KEY).toBe('s3cret')
	})

	it('still reads JWT_SECRET_KEY', async () => {
		process.env.JWT_SECRET_KEY = 's3cret'

		expect((await loadConfig()).JWT_SECRET_KEY).toBe('s3cret')
	})

	it('refuses both settings at once', async () => {
		process.env.JWT_SECRET_KEY = 's3cret'
		process.env.JWT_SECRET_KEY_FILE = secretFile('other')

		const config = await loadConfig()

		expect(() => config.JWT_SECRET_KEY).toThrow('not both')
	})

	it.each([
		['a missing file', () => join(dir, 'missing')],
		['an empty file', () => secretFile('\n')],
	])('fails clearly for %s', async (_, path) => {
		process.env.JWT_SECRET_KEY_FILE = path()
		const config = await loadConfig()

		expect(() => config.JWT_SECRET_KEY).toThrow('[FATAL]')
	})
})
