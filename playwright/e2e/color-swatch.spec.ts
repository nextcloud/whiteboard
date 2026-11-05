/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Properties ${Date.now()}` })
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 600, y: 400 } })
	await page.keyboard.press('r')
})

test('a color swatch keeps its color when focused or hovered', async ({ page }) => {
	const red = page.getByTestId('color-top-pick-#e03131').first()

	await red.focus()
	await expect(red).toHaveCSS('background-color', 'rgb(224, 49, 49)')

	await red.hover()
	await expect(red).toHaveCSS('background-color', 'rgb(224, 49, 49)')
})
