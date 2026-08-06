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
	openWhiteboardFromFiles,
	waitForCanvas,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('whiteboard content persists after reload and reopen', async ({ page }) => {
	const boardName = `Persistent whiteboard ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Persistent content')

	const resolveAuth = async () => {
		try {
			return await getBoardAuth(page)
		} catch {
			const { fileId, jwt } = await captureBoardAuthFromSave(page, { containsText: 'Persistent content' })
			return { fileId, jwt }
		}
	}

	const fetchContent = async (authToUse: { fileId: number, jwt: string }) => {
		const content = await fetchBoardContent(page, auth)
		return JSON.stringify(content)
	}

	const auth = await resolveAuth()

	await expect.poll(async () => fetchContent(auth), {
		timeout: 10000,
		interval: 500,
	}).toContain('Persistent content')

	await page.reload()
	await waitForCanvas(page)

	await expect.poll(async () => fetchContent(auth), {
		timeout: 10000,
		interval: 500,
	}).toContain('Persistent content')

	await openWhiteboardFromFiles(page, boardName)
	await expect.poll(async () => fetchContent(auth), {
		timeout: 10000,
		interval: 500,
	}).toContain('Persistent content')
})

test('download screenshot from main menu', async ({ page }) => {
	const boardName = `Screenshot check ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Screenshot marker')

	await page.getByTestId('main-menu-trigger').click()
	const downloadItem = page.getByText('Download screenshot', { exact: false }).first()
	await expect(downloadItem).toBeVisible()
	const downloadPromise = page.waitForEvent('download')
	await downloadItem.click()

	const download = await downloadPromise
	expect(await download.path()).not.toBeNull()
	expect(download.suggestedFilename()).toContain('Screenshot')
})
