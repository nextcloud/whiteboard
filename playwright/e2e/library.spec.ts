/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('library menu offers saving the board as a canvas', async ({ page }) => {
	test.setTimeout(120000)
	await createWhiteboard(page, { name: `Library ${Date.now()}` })

	await page.locator('.default-sidebar-trigger').first().click()
	const library = page.locator('.layer-ui__library')
	await expect(library).toBeVisible()

	await library.getByTestId('dropdown-menu-button').click()
	await expect(page.getByTestId('lib-dropdown--save-as-canvas-template')).toHaveText('Save as canvas...')
})
