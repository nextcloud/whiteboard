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
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('whiteboard changes sync across sessions', async ({ page, browser, user }) => {
	test.setTimeout(90000)
	const boardName = `Collab board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	const waitForSaveWithText = (targetPage: typeof page, text: string) => targetPage.waitForResponse(
		(response) => {
			if (response.request().method() !== 'PUT') return false
			if (!response.url().includes('/apps/whiteboard/')) return false
			return (response.request().postData() || '').includes(text)
		},
		{ timeout: 60000 },
	)
	const savePromise = waitForSaveWithText(page, 'First session text')
	await addTextElement(page, 'First session text')
	const firstSave = await savePromise

	const authHeader = firstSave.request().headers()['authorization']
	expect(authHeader).toBeTruthy()
	const apiPath = new URL(firstSave.url()).pathname.replace('/index.php/', '')
	const fileId = Number(apiPath.split('/').pop())
	expect(fileId).toBeGreaterThan(0)

	const pageB = await newLoggedInPage(page, browser)
	await openWhiteboardFromFiles(pageB, boardName)
	const fetchContent = async (targetPage) => {
		const response = await targetPage.request.get(apiPath, {
			headers: { Authorization: authHeader },
		})
		expect(response.ok()).toBeTruthy()
		const body = await response.json()
		return JSON.stringify(body.data)
	}

	await expect.poll(async () => fetchContent(pageB), { timeout: 20000, interval: 500 }).toContain('First session text')

	const syncerSave = waitForSaveWithText(page, 'Second session text')
	await addTextElement(pageB, 'Second session text')
	await syncerSave

	await expect.poll(async () => fetchContent(page), { timeout: 30000, interval: 500 }).toContain('Second session text')

	await pageB.close()
})
