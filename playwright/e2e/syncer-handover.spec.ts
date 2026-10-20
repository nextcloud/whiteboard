/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Browser, Page } from '@playwright/test'

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

const boardSave = /\/apps\/whiteboard\/\d+$/

/**
 * Shares a new board of the owner with an editor and opens it for both. The
 * owner joins first and saves; the editor joins second and only receives.
 */
async function openSharedBoard(page: Page, browser: Browser, baseURL: string | undefined) {
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

	await openWhiteboardFromFiles(page, boardName)
	const context = await browser.newContext({ baseURL })
	const editorPage = await context.newPage()
	await login(editorPage.request, editor)
	await openWhiteboardFromFiles(editorPage, storedName, { preferSharedView: true })
	const boardText = async () => JSON.stringify(await fetchBoardContent(editorPage, auth))

	return { editorPage, context, boardText }
}

test('the user who takes over saving stores the last edit of the user who left', async ({ page, browser, baseURL }) => {
	test.slow()
	const { editorPage, context, boardText } = await openSharedBoard(page, browser, baseURL)

	const editorSaves = { count: 0 }
	editorPage.on('request', (request) => {
		if (request.method() === 'PUT' && boardSave.test(request.url())) {
			editorSaves.count++
		}
	})

	// The owner's saves never reach the server, so only the editor can store this edit
	await page.route(boardSave, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
	await addTextElement(page, 'Last edit of the owner', { x: 600, y: 550 })
	// Lets the edit reach the editor over the websocket (sent every 500 ms)
	await page.waitForTimeout(2000)
	await page.close()

	await expect.poll(boardText, { timeout: 30000 }).toContain('Last edit of the owner')
	expect(editorSaves.count).toBeGreaterThan(0)
	await context.close()
})

test('a save still running when the saver closes the board does not replace the next saver\'s edits', async ({ page, browser, baseURL }) => {
	test.slow()
	const { editorPage, context, boardText } = await openSharedBoard(page, browser, baseURL)

	// The next save of the owner reaches the server, but its response waits,
	// so the owner's last save waits in the queue behind it
	let releaseResponse!: () => void
	const responseReleased = new Promise<void>((resolve) => {
		releaseResponse = () => resolve()
	})
	let saveStored!: () => void
	const firstSaveStored = new Promise<void>((resolve) => {
		saveStored = () => resolve()
	})
	let isHolding = false
	await page.route(boardSave, async (route) => {
		if (route.request().method() !== 'PUT' || isHolding) {
			return route.continue()
		}
		isHolding = true
		const response = await route.fetch()
		saveStored()
		await responseReleased
		await route.fulfill({ response })
	})

	await addTextElement(page, 'First edit of the owner', { x: 600, y: 550 })
	await firstSaveStored
	await addTextElement(page, 'Last edit of the owner', { x: 600, y: 650 })
	// Lets the edit reach the editor over the websocket (sent every 500 ms)
	await page.waitForTimeout(2000)
	await page.getByRole('button', { name: 'Close', exact: true }).click()
	await expect(page.locator('.excalidraw')).toHaveCount(0)

	// Had the editor taken over saving at once, it stores its edit within 20 s
	const editorSave = editorPage.waitForResponse((response) => response.request().method() === 'PUT'
		&& (response.request().postData() ?? '').includes('Edit of the editor'), { timeout: 30000 }).catch(() => null)
	await addTextElement(editorPage, 'Edit of the editor', { x: 300, y: 650 })
	await editorSave
	const ownerLastSave = page.waitForResponse((response) => response.request().method() === 'PUT'
		&& (response.request().postData() ?? '').includes('Last edit of the owner'))
	releaseResponse()
	await ownerLastSave

	await expect.poll(boardText, { timeout: 30000 }).toContain('Edit of the editor')
	expect(await boardText()).toContain('Last edit of the owner')
	await context.close()
})
