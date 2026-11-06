/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Keyboard ${Date.now()}` })
})

test('the main menu button has a name', async ({ page }) => {
	await expect(page.locator('.excalidraw').getByRole('button', { name: 'Menu', exact: true })).toBeVisible()
})

for (const key of ['Tab', 'Shift+Tab']) {
	test(`${key} leaves the canvas when nothing is selected`, async ({ page }) => {
		const canvas = await getCanvasForInteraction(page)
		await canvas.click({ position: { x: 600, y: 400 } })
		const board = page.locator('.excalidraw-container')
		await expect(board).toBeFocused()

		await page.keyboard.press(key)

		await expect(board).not.toBeFocused()
	})
}
