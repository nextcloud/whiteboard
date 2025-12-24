/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('test whiteboard server is reachable', async ({ page }) => {
	await page.goto('http://localhost:3002')
	await expect(page.locator('body')).toContainText('Nextcloud Whiteboard Collaboration Server')
})

test('open a whiteboard', async ({ page }) => {
	const boardName = `Viewer ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	await page.getByTitle('Text — T or').locator('div').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: {
			x: 534,
			y: 249,
		},
	})
	await page.locator('textarea').fill('Test')
	await canvas.click({
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
