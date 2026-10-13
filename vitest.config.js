/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import vue from '@vitejs/plugin-vue'
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
  console.warn('⚠️  Skipping Redis-dependent tests (multinode-redis.spec.mjs)')
}
export default defineConfig({
	// Compiles .vue files for the component tests.
	plugins: [vue()],
	test: {
		environment: 'node',
		server: {
			deps: {
				// Imports its own CSS, which only Vite can load.
				inline: [/@nextcloud\/vue/],
			},
		},
		include: [
			'tests/integration/*.spec.?(c|m)[jt]s?(x)',
		],
		exclude: redisMemoryServerAvailable
			? []
			: [
				'**/multinode-redis.spec.mjs',
			],
	},
})
