/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Page } from '@playwright/test'

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { addTextElement, captureBoardAuthFromSave, createWhiteboard, fetchBoardContent, openFilesApp, openWhiteboardFromFiles, waitForCanvas } from '../support/utils'

function countBoardSaves(page: Page) {
	const saves = { count: 0 }
	page.on('request', (request) => {
		if (request.method() === 'PUT' && /\/apps\/whiteboard\/\d+$/.test(request.url())) {
			saves.count++
		}
	})
	return saves
}

test('only one tab of a user saves the board, and another tab takes over when it closes', async ({ page, browser, baseURL }) => {
	test.slow()
	const boardName = `Two tabs ${Date.now()}`
	// Two tabs of one browser profile share their storage, the fixture page has a context of its own
	const context = await browser.newContext({ baseURL, storageState: await page.context().storageState() })
	const firstTab = await context.newPage()
	const secondTab = await context.newPage()

	await openFilesApp(firstTab)
	await createWhiteboard(firstTab, { name: boardName })
	const firstSave = captureBoardAuthFromSave(firstTab, { containsText: 'From the first tab' })
	await addTextElement(firstTab, 'From the first tab')
	const auth = await firstSave
	const boardText = async () => JSON.stringify(await fetchBoardContent(secondTab, auth))

	await openWhiteboardFromFiles(secondTab, boardName)
	const firstTabSaves = countBoardSaves(firstTab)
	const secondTabSaves = countBoardSaves(secondTab)

	await addTextElement(secondTab, 'From the second tab', { x: 600, y: 250 })
	await expect.poll(boardText, { timeout: 30000 }).toContain('From the second tab')
	// Longer than the 10 s between two saves of a tab
	await secondTab.waitForTimeout(12000)
	expect(firstTabSaves.count).toBeGreaterThan(0)
	expect(secondTabSaves.count).toBe(0)

	// The first tab's own saves never reach the server, so only the second tab can store this edit
	await firstTab.route(/\/apps\/whiteboard\/\d+$/, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
	await addTextElement(firstTab, 'Last edit of the first tab', { x: 600, y: 550 })
	// Lets the edit reach the second tab over the websocket (sent every 500 ms)
	await firstTab.waitForTimeout(2000)
	await firstTab.close()

	await expect.poll(boardText, { timeout: 60000 }).toContain('Last edit of the first tab')
	expect(secondTabSaves.count).toBeGreaterThan(0)
	await context.close()
})

test('a tab that opens the board again while another tab saves drops its last save that has not started', async ({ page, browser, baseURL }) => {
	test.slow()
	const boardName = `Reopen as follower ${Date.now()}`
	const context = await browser.newContext({ baseURL, storageState: await page.context().storageState() })
	const firstTab = await context.newPage()
	const secondTab = await context.newPage()

	await openFilesApp(firstTab)
	await createWhiteboard(firstTab, { name: boardName })
	const firstSave = captureBoardAuthFromSave(firstTab, { containsText: 'Saved first' })
	await addTextElement(firstTab, 'Saved first')
	const auth = await firstSave
	const boardText = async () => JSON.stringify(await fetchBoardContent(secondTab, auth))
	await openWhiteboardFromFiles(secondTab, boardName)

	// Holds the first tab's next save, so the save of its last scene waits in the worker
	let release = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const firstTabSaves = countBoardSaves(firstTab)
	await firstTab.route(/\/apps\/whiteboard\/\d+$/, async (route) => {
		if (route.request().method() === 'PUT') {
			await held
		}
		await route.continue()
	})
	await addTextElement(firstTab, 'Held save', { x: 600, y: 250 })
	await expect.poll(() => firstTabSaves.count, { timeout: 20000 }).toBe(1)
	await addTextElement(firstTab, 'Last scene of the first tab', { x: 600, y: 550 })
	// Longer than the 10 s between two saves of a tab, so the next save waits behind the held one
	await firstTab.waitForTimeout(12000)

	await firstTab.getByRole('button', { name: 'Close', exact: true }).last().click()
	await expect.poll(boardText, { timeout: 60000 }).toContain('Last scene of the first tab')
	// Opens it from the file list of the same page, so its worker still holds the waiting save
	await firstTab.locator('[data-cy-files-list-row-name-link]').filter({ hasText: boardName }).first().click()
	await waitForCanvas(firstTab)
	await firstTab.waitForTimeout(3000)
	release()
	await firstTab.waitForTimeout(5000)

	expect(firstTabSaves.count).toBe(1)
	await context.close()
})
