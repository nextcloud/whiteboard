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
	test.setTimeout(120000)
	await createWhiteboard(page, { name: `Voting ${Date.now()}` })

	// Reopen the Vue dialog repeatedly to catch mount/unmount leaks.
	const startNewVoting = page.getByRole('button', { name: /start new voting/i })
	const openVotingSidebar = async () => {
		if (await startNewVoting.isVisible().catch(() => false)) {
			return
		}
		await page.getByTestId('main-menu-trigger').click()
		await page.getByRole('button', { name: 'Votings', exact: true }).click()
		await expect(startNewVoting).toBeVisible()
	}

	for (let i = 0; i < 5; i++) {
		await openVotingSidebar()
		await startNewVoting.click()
		const dialog = page.getByRole('dialog', { name: /start new voting/i }).last()
		await expect(dialog).toBeVisible()
		await dialog.getByRole('button', { name: /close/i }).click()
		await expect(dialog).toBeHidden()
	}

	await openVotingSidebar()
	await startNewVoting.click()
	const votingDialog = page.getByRole('dialog', { name: /start new voting/i }).last()

	await votingDialog.getByLabel(/question/i).fill('What is your favorite color?')

	await votingDialog.getByLabel(/option 1/i).fill('Red')
	await votingDialog.getByLabel(/option 2/i).fill('Blue')
	await votingDialog.getByRole('button', { name: /add option/i }).click()
	await votingDialog.getByLabel(/option 3/i).fill('Green')

	await votingDialog.getByRole('button', { name: /Start voting/i }).click()

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
