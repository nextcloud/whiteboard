/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'

test.beforeEach(async ({ page }) => {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
})

test('embed whiteboard in another whiteboard', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.keyboard.type('first whiteboard')
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()

	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)

	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()

	await page.getByTitle('Smart picker').click()
	await expect(page.locator('.reference-picker')).toBeVisible({ timeout: 5000 })

	await page.locator('#provider-select-input').click()
	await page.keyboard.type('Files')
	await page.keyboard.press('Enter')

	await expect(page.locator('.file-picker')).toBeVisible({ timeout: 5000 })
	await page.getByTitle('first whiteboard').click()
	await page.getByLabel('Choose first whiteboard').click()

	await expect(page.locator('.whiteboard-viewer__embedding').getByText('Drawing canvas')).toBeVisible()
})
