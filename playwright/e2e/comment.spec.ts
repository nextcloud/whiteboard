/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('create comment and reply', async ({ page }) => {
	const boardName = `Comment ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	await page.locator('.comment-trigger').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: { x: 400, y: 300 },
	})

	await expect(page.locator('.comment-popover')).toBeVisible()

	await page.locator('.comment-popover textarea').fill('First comment')
	await page.locator('.comment-popover .comment-popover__button').click()

	await expect(page.locator('.comment-popover')).toContainText('First comment')

	await page.locator('.comment-popover textarea').fill('Reply comment')
	await page.locator('.comment-popover .comment-popover__button').click()

	await expect(page.locator('.comment-popover')).toContainText('First comment')
	await expect(page.locator('.comment-popover')).toContainText('Reply comment')
	await expect(page.locator('.comment-pin')).toBeVisible()
})
