/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'

test.beforeEach(async ({ page }) => {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
})

test('test whiteboard server is reachable', async ({ page }) => {
	await page.goto('http://localhost:3002')
	await expect(page.locator('body')).toContainText('Excalidraw collaboration server is up :)')
})

test('open a whiteboard', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()
	await expect(page.getByRole('region', { name: 'Shapes' }).locator('rect')).toBeVisible()
	await page.getByTitle('Rectangle — R or').locator('path').click()
	await page.locator('.excalidraw').press('Enter')
	await page.locator('textarea').fill('Test')
	await page.getByText('Drawing canvas').click({
		position: {
			x: 877,
			y: 287,
		}
	})
})