/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	createWhiteboard,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardFromFiles,
} from '../support/utils'

async function ensureTimerVisible(page: Page) {
	// Use .timer selector instead of .timer-overlay because the overlay wrapper
	// has zero dimensions (its child DraggableDialog uses position: fixed)
	const timer = page.locator('.timer')
	if (await timer.count()) {
		await expect(timer).toBeVisible({ timeout: 15000 })
		return timer
	}

	await page.getByTestId('main-menu-trigger').click()
	const toggleItem = page.getByText(/Show timer|Hide timer/).first()
	await expect(toggleItem).toBeVisible({ timeout: 15000 })
	await toggleItem.click()

	await expect(timer).toBeVisible({ timeout: 15000 })
	return timer
}

async function waitForCollaboration(page: Page) {
	await expect(page.locator('.network-status')).toHaveCount(0, { timeout: 30000 })
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('timer can start, pause, resume, and reset', async ({ page }) => {
	const boardName = `Timer board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await waitForCollaboration(page)

	const timer = await ensureTimerVisible(page)

	await timer.getByLabel('Minutes').fill('1')
	await timer.getByLabel('Seconds').fill('0')
	await timer.getByRole('button', { name: 'Start' }).click()

	await expect(timer.getByText('Running')).toBeVisible({ timeout: 15000 })
	await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible()

	await timer.getByRole('button', { name: 'Pause' }).click()
	await expect(timer.getByText('Paused')).toBeVisible({ timeout: 15000 })
	await expect(timer.getByRole('button', { name: 'Resume' })).toBeVisible()

	await timer.getByRole('button', { name: 'Resume' }).click()
	await expect(timer.getByText('Running')).toBeVisible({ timeout: 15000 })

	await timer.getByRole('button', { name: 'Reset' }).click()
	await expect(timer.getByText('Ready')).toBeVisible({ timeout: 15000 })
	await expect(timer.getByLabel('Minutes')).toHaveValue('0')
	await expect(timer.getByLabel('Seconds')).toHaveValue('0')
})

test('timer state syncs across sessions', async ({ page, browser }) => {
	test.setTimeout(90000)
	const boardName = `Timer sync ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await waitForCollaboration(page)

	const timer = await ensureTimerVisible(page)
	await timer.getByLabel('Minutes').fill('1')
	await timer.getByRole('button', { name: 'Start' }).click()
	await expect(timer.getByText('Running')).toBeVisible({ timeout: 15000 })

	const viewerPage = await newLoggedInPage(page, browser)
	await openWhiteboardFromFiles(viewerPage, boardName)
	await waitForCollaboration(viewerPage)

	const viewerTimer = await ensureTimerVisible(viewerPage)
	await expect(viewerTimer.getByText('Running')).toBeVisible({ timeout: 20000 })
	await viewerTimer.getByRole('button', { name: 'Pause' }).click()

	await expect(viewerTimer.getByText('Paused')).toBeVisible({ timeout: 20000 })
	await expect(timer.getByText('Paused')).toBeVisible({ timeout: 20000 })

	await viewerPage.close()
})
