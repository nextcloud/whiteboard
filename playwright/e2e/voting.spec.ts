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

test('Create a voting and add it to the whiteboard', async ({ page }) => {
	await createWhiteboard(page, { name: `Voting ${Date.now()}` })

	// Open the main menu and navigate to voting
	await page.getByTestId('main-menu-trigger').click()
	await page.getByRole('button', { name: /voting/i }).click()

	// Start a new voting
	await page.getByRole('button', { name: /start new voting/i }).click()

	await page.getByLabel(/question/i).fill('What is your favorite color?')

	await page.getByLabel(/option 1/i).fill('Red')
	await page.getByLabel(/option 2/i).fill('Blue')
	await page.getByRole('button', { name: /add option/i }).click()
	await page.getByLabel(/option 3/i).fill('Green')

	await page.getByRole('button', { name: /Start voting/i }).click()

	await expect(page.getByText('What is your favorite color?')).toBeVisible()

	// Vote for the first option
	await page.getByText('Red').locator('..').getByRole('button', { name: /vote/i }).click()
	await expect(page.getByText('Red').locator('..').getByText(/voted/i)).toBeVisible()

	// End the voting
	await page.getByRole('button', { name: /end voting/i }).click()
	await expect(page.getByText(/status.*closed/i)).toBeVisible()

	// Add results as drawing
	await page.getByRole('button', { name: /add as drawing/i }).click()
	await expect(page.locator('text=Voting results')).toBeVisible()
	await expect(page.locator('text=What is your favorite color?')).toBeVisible()
})
