/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	createWhiteboard,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardFromFiles,
	waitForCanvas,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('presentation session broadcasts and follow toggle works across sessions', async ({ page, browser }) => {
	test.setTimeout(120000)
	const boardName = `Presentation board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Presenter content')
	await waitForCanvas(page)

	// Ensure collaboration is online before proceeding
	const presenterNetwork = page.locator('.network-status')
	await expect(presenterNetwork).toBeVisible({ timeout: 20000 })
	await expect(presenterNetwork).toHaveClass(/network-status--online/, { timeout: 20000 })

	// Join the board with a second session before starting the presentation
	const viewerPage = await newLoggedInPage(page, browser)
	await openWhiteboardFromFiles(viewerPage, boardName)
	const viewerNetwork = viewerPage.locator('.network-status')
	await expect(viewerNetwork).toBeVisible({ timeout: 20000 })
	await expect(viewerNetwork).toHaveClass(/network-status--online/, { timeout: 20000 })

	// Start presenting from the first session
	await page.getByTestId('main-menu-trigger').click()
	const startButton = page.getByText('Start Presentation', { exact: false }).first()
	await expect(startButton).toBeVisible({ timeout: 15000 })
	await startButton.click()
	await expect(page.getByText('You are presenting')).toBeVisible({ timeout: 20000 })

	// The watcher should be notified about the active presentation
	await expect(viewerPage.getByText('is presenting')).toBeVisible({ timeout: 20000 })

	const followButton = viewerPage.getByRole('button', { name: /Follow/ }).first()
	await expect(followButton).toHaveText(/Following/i)
	await followButton.click()
	await expect(followButton).toHaveText(/Follow/i)

	// Stop the presentation from the presenter session
	await page.getByTestId('main-menu-trigger').click()
	const stopButton = page.getByText('Stop Presentation', { exact: false }).first()
	await expect(stopButton).toBeVisible({ timeout: 15000 })
	await stopButton.click()

	await expect(page.getByText('You are presenting')).toHaveCount(0, { timeout: 20000 })
	await expect(viewerPage.getByText('is presenting')).toHaveCount(0, { timeout: 20000 })

	await viewerPage.close()
})
