/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

module.exports = {
	extends: [
		'@nextcloud/eslint-config/typescript'
	],
	rules: {
		'jsdoc/require-jsdoc': 'off',
		'import/no-unresolved': [
			'error',
			{
				ignore: [
					'\\.css$'
				]
			}
		]
	},
	overrides: [
		{
			files: [
				'src/components/CreatorMenuItem.tsx'
			],
			rules: {
				'indent': 'off'
			}
		}
	]
}
