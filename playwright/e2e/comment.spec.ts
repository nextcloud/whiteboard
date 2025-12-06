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

test('create comment and reply', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()

	await page.locator('.comment-trigger').click()
	await page.getByText('Drawing canvas').click({
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
