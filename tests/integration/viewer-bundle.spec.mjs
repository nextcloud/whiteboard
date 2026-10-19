/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import createConfig from '../../vite.config.ts'

const REACT_MODULE = /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/

describe('viewer init script', () => {
	it('loads no React on pages that only register the viewer handler', async () => {
		const config = await createConfig({ command: 'build', mode: 'production' })
		config.configFile = false
		config.root = fileURLToPath(new URL('../..', import.meta.url))
		config.logLevel = 'silent'
		config.build = { ...config.build, write: false, sourcemap: false, minify: false }

		const results = await build(config)
		const chunks = new Map((Array.isArray(results) ? results : [results])
			.flatMap(({ output }) => output)
			.filter((file) => file.type === 'chunk')
			.map((chunk) => [chunk.fileName, chunk]))
		const entry = [...chunks.values()].find((chunk) => chunk.isEntry && chunk.fileName.endsWith('whiteboard-viewer.mjs'))

		const loaded = new Set()
		const pending = [entry.fileName]
		while (pending.length > 0) {
			const fileName = pending.pop()
			if (!loaded.has(fileName)) {
				loaded.add(fileName)
				pending.push(...chunks.get(fileName).imports)
			}
		}
		const reactModules = [...loaded]
			.flatMap((fileName) => Object.keys(chunks.get(fileName).modules))
			.filter((id) => REACT_MODULE.test(id))

		expect(reactModules).toEqual([])
	}, 300_000)
})
