/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from 'vitest/config'
import { execSync } from 'child_process'

process.env.REDISMS_DISABLE_POSTINSTALL = '0'

let redisMemoryServerAvailable = false

try {
  console.log('Rebuilding redis-memory-server...')
  execSync('npm rebuild redis-memory-server', { stdio: 'inherit' })
  redisMemoryServerAvailable = true
} catch (e) {
  console.error('Failed to rebuild redis-memory-server:', e?.message ?? e)
  console.warn('⚠️  Skipping Redis-dependent tests (multinode-redis.spec.mjs, redisClient.spec.mjs)')
}
export default defineConfig({
	resolve: {
		// As in the build: components import Excalidraw's stylesheet under its upstream name
		alias: [{ find: /^@excalidraw\/excalidraw\/index\.css$/, replacement: '@nextcloud/excalidraw/index.css' }],
	},
	test: {
		environment: 'node',
		// The viewer bundle test builds the whole app
		execArgv: ['--max-old-space-size=6144'],
		include: [
			'tests/integration/*.spec.?(c|m)[jt]s?(x)',
		],
		exclude: redisMemoryServerAvailable
			? []
			: [
				'**/multinode-redis.spec.mjs',
				'**/redisClient.spec.mjs',
			],
		server: {
			deps: {
				inline: ['@nextcloud/excalidraw'],
			},
		},
	},
})
