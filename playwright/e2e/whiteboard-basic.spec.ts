/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	createWhiteboard,
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

	const saveResponse = await page.waitForResponse((response) => {
		const request = response.request()
		return request.method() === 'PUT' && response.url().includes('/apps/whiteboard/')
	}, { timeout: 20000 })

	const savePayload = saveResponse.request().postData() || ''
	expect(savePayload).toContain('Persistent content')

	const authHeader = saveResponse.request().headers()['authorization']
	const apiPath = new URL(saveResponse.url()).pathname.replace('/index.php/', '')
	expect(authHeader).toBeTruthy()
	expect(apiPath).toContain('apps/whiteboard/')

	const fetchBoardContent = async () => {
		const response = await page.request.get(apiPath, {
			headers: { Authorization: authHeader },
		})
		expect(response.ok()).toBeTruthy()
		const body = await response.json()
		return JSON.stringify(body.data)
	}

	await expect.poll(async () => fetchBoardContent(), {
		timeout: 10000,
		interval: 500,
	}).toContain('Persistent content')

	await page.reload()
	await waitForCanvas(page)

	await expect.poll(async () => fetchBoardContent(), {
		timeout: 10000,
		interval: 500,
	}).toContain('Persistent content')

	await openWhiteboardFromFiles(page, boardName)
	await expect.poll(async () => fetchBoardContent(), {
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
