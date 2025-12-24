/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, dismissRecordingNotice, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('recording unavailable notice is dismissible and main menu remains usable', async ({ page }) => {
	await createWhiteboard(page, { name: `Recording check ${Date.now()}` })

	const notice = page.locator('.recording-unavailable')
	if (await notice.count()) {
		await expect(notice).toBeVisible({ timeout: 20000 })
		await expect(notice.getByText('Recording unavailable')).toBeVisible()
	}

	await dismissRecordingNotice(page)
	await expect(notice).toBeHidden({ timeout: 5000 })

	await page.getByTestId('main-menu-trigger').click()
	const recordingButton = page.locator('.recording-button')
	const presentationButton = page.locator('.presentation-button')
	await expect(recordingButton).toBeVisible()
	await expect(presentationButton).toBeVisible()
})
