/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { recommendedVue2Javascript } from '@nextcloud/eslint-config'
import { defineConfig } from 'eslint/config'

// ceiling: existing v9 violations are baselined; upgrade when touching a listed file by fixing and pruning its suppressions.
export default defineConfig([
	...recommendedVue2Javascript,
	{
		name: 'whiteboard/rules',
		rules: {
			'jsdoc/require-jsdoc': 'off',
		},
	},
	{
		name: 'whiteboard/websocket-server',
		files: [
			'websocket_server/**/*.js',
		],
		languageOptions: {
			globals: {
				Buffer: 'readonly',
				process: 'readonly',
			},
		},
	},
	{
		name: 'whiteboard/creator-menu-item',
		files: [
			'src/components/CreatorMenuItem.tsx',
		],
		rules: {
			'@stylistic/indent': 'off',
		},
	},
])
