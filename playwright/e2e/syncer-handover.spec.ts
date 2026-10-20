/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	openFilesApp,
	openWhiteboardFromFiles,
	resolveStoredFileName,
} from '../support/utils'

test('the user who takes over saving stores the last edit of the user who left', async ({ page, browser, baseURL }) => {
	test.slow()
	const boardName = `Handover ${Date.now()}`

	await openFilesApp(page)
	await createWhiteboard(page, { name: boardName })
	const firstSave = captureBoardAuthFromSave(page, { containsText: 'Saved by the owner' })
	await addTextElement(page, 'Saved by the owner')
	const auth = await firstSave

	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)
	const editor = await createRandomUser()
	await createUserShare(page, { fileName: storedName, shareWith: editor.userId, permissions: 15 })

	// The owner joins first and saves; the editor joins second and only receives
	await openWhiteboardFromFiles(page, boardName)
	const context = await browser.newContext({ baseURL })
	const editorPage = await context.newPage()
	await login(editorPage.request, editor)
	await openWhiteboardFromFiles(editorPage, storedName, { preferSharedView: true })
	const boardText = async () => JSON.stringify(await fetchBoardContent(editorPage, auth))

	const editorSaves = { count: 0 }
	editorPage.on('request', (request) => {
		if (request.method() === 'PUT' && /\/apps\/whiteboard\/\d+$/.test(request.url())) {
			editorSaves.count++
		}
	})

	// The owner's saves never reach the server, so only the editor can store this edit
	await page.route(/\/apps\/whiteboard\/\d+$/, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
	await addTextElement(page, 'Last edit of the owner', { x: 600, y: 550 })
	// Lets the edit reach the editor over the websocket (sent every 500 ms)
	await page.waitForTimeout(2000)
	await page.close()

	await expect.poll(boardText, { timeout: 30000 }).toContain('Last edit of the owner')
	expect(editorSaves.count).toBeGreaterThan(0)
	await context.close()
})
