/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('embed whiteboard in another whiteboard', async ({ page }) => {
	const firstBoardName = `first whiteboard ${Date.now()}`
	await createWhiteboard(page, { name: firstBoardName })

	await openFilesApp(page)

	const secondBoardName = `second whiteboard ${Date.now()}`
	await createWhiteboard(page, { name: secondBoardName })

	await page.getByTitle('Smart picker').click()
	await expect(page.locator('.reference-picker')).toBeVisible({ timeout: 5000 })

	await page.locator('#provider-select-input').click()
	await page.keyboard.type('Files')
	await page.keyboard.press('Enter')

	await expect(page.locator('.file-picker')).toBeVisible({ timeout: 5000 })
	const fileEntry = page.getByTitle(firstBoardName).first()
	await expect(fileEntry).toBeVisible({ timeout: 20000 })
	await fileEntry.click()

	const chooseButton = page.getByLabel(`Choose ${firstBoardName}`).first()
	await expect(chooseButton).toBeVisible({ timeout: 10000 })
	await chooseButton.click()

	const embeddedCanvas = page.locator('.whiteboard-viewer__embedding .excalidraw__canvas').first()
	await expect(embeddedCanvas).toBeVisible({ timeout: 20000 })
})
