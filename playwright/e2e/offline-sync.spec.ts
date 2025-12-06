/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createWhiteboard,
	fetchBoardContent,
	getBoardAuth,
	openFilesApp,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('offline edits sync after reconnect', async ({ page }) => {
	test.setTimeout(90000)
	const boardName = `Offline board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Online text')

	let auth
	try {
		auth = await getBoardAuth(page)
	} catch {
		auth = await captureBoardAuthFromSave(page)
	}

	const status = page.locator('.network-status')

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 30000,
		interval: 500,
	}).toContain('Online text')

	await page.context().setOffline(true)
	await page.waitForTimeout(2000)

	await addTextElement(page, 'Offline text', { x: 520, y: 320 })
	await page.waitForTimeout(2000)

	await page.context().setOffline(false)
	await expect(status).toHaveClass(/network-status--online/, { timeout: 20000 })

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 45000,
		interval: 500,
	}).toContain('Offline text')
})
