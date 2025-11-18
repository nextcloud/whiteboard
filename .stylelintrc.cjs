/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const stylelintConfig = require('@nextcloud/stylelint-config')

stylelintConfig.rules['no-invalid-position-at-import-rule'] = null

stylelintConfig.overrides = stylelintConfig.overrides || []
stylelintConfig.overrides.push({
	files: ['src/**/*.module.scss'],
	rules: {
		'selector-pseudo-class-disallowed-list': ['global'],
	},
})

module.exports = stylelintConfig
