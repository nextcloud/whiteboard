/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { dismissRecordingNotice, waitForCanvas } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
})

test('test whiteboard server is reachable', async ({ page }) => {
	await page.goto('http://localhost:3002')
	await expect(page.locator('body')).toContainText('Nextcloud Whiteboard Collaboration Server')
})

test('open a whiteboard', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await waitForCanvas(page)
	await dismissRecordingNotice(page)

	await page.getByTitle('Text — T or').locator('div').click()
	await page.getByText('Drawing canvas').click({
		position: {
			x: 534,
			y: 249,
		},
	})
	await page.locator('textarea').fill('Test')
	await page.getByText('Drawing canvas').click({
		position: {
			x: 683,
			y: 214,
		},
	})
	await page.getByTestId('main-menu-trigger').click()
	await expect(page.getByText('Canvas backgroundExport image')).toBeVisible()
	await page.getByTestId('main-menu-trigger').click()
	await page.getByTestId('dropdown-menu-button').click()
})
