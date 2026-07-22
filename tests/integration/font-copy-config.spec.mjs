/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'

import createConfig from '../../vite.config.ts'

describe('Excalidraw font assets', () => {
	it('copies fonts to dist/fonts instead of preserving node_modules in the URL path', async () => {
		const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
		const temporaryDirectory = await mkdtemp(join(tmpdir(), 'whiteboard-font-copy-'))
		const entry = join(temporaryDirectory, 'entry.js')
		const output = join(temporaryDirectory, 'output')

		try {
			await writeFile(entry, '')
			const config = await createConfig({ command: 'build', mode: 'production' })
			config.configFile = false
			config.root = projectRoot
			config.logLevel = 'silent'
			config.build = {
				...config.build,
				emptyOutDir: true,
				outDir: output,
				rollupOptions: {
					...config.build.rollupOptions,
					input: { fontCopyTest: entry },
				},
			}
			await build(config)

			await expect(access(join(output, 'dist/fonts/Assistant/Assistant-Regular.woff2'))).resolves.toBeUndefined()
			await expect(access(join(output, 'dist/node_modules'))).rejects.toThrow()
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true })
		}
	})
})
