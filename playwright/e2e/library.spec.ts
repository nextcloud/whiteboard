/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, openFilesApp, waitForCanvas } from '../support/utils'

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

test('organization libraries can be hidden per user', async ({ page }) => {
	test.setTimeout(120000)
	await createWhiteboard(page, { name: `Organization libraries ${Date.now()}` })

	const openOrganizationLibraries = async () => {
		const manageLibraries = page.getByRole('button', { name: 'Manage libraries' })
		if (!(await page.locator('.default-sidebar').isVisible())) {
			await page.locator('.default-sidebar-trigger').first().click()
		}
		await manageLibraries.click()
		return page.getByRole('dialog', { name: 'Manage libraries' }).getByRole('switch').first()
	}

	const library = await openOrganizationLibraries()
	await expect(library).toBeChecked()

	const saved = page.waitForResponse((response) => response.url().includes('/libraries/visibility') && response.ok())
	await library.uncheck({ force: true })
	await saved

	await page.reload()
	await waitForCanvas(page)
	await expect(await openOrganizationLibraries()).not.toBeChecked()
})
