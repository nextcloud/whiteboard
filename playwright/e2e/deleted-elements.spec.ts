/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Browser, Page } from '@playwright/test'

import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user.ts'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	getCanvasForInteraction,
	openFilesApp,
	openWhiteboardFromFiles,
	resolveStoredFileName,
} from '../support/utils.ts'

const DELETED_TEXT = 'Deleted before the insert'

function enableTestHooks() {
	(window as any).__whiteboardTest = true
}

function isInRoom(page: Page) {
	return page.evaluate(() => {
		const state = (window as any).__whiteboardTestHooks?.collaborationStore?.getState()
		return Boolean(state?.socket?.connected && state.isInRoom)
	})
}

async function setConnected(page: Page, connected: boolean) {
	await page.evaluate((connected) => {
		const { socket } = (window as any).__whiteboardTestHooks.collaborationStore.getState()
		socket.io.reconnection(connected)
		if (connected) {
			socket.connect()
		} else {
			socket.io.engine.close()
		}
	}, connected)
	await expect.poll(() => isInRoom(page), { timeout: 30000, intervals: [500] }).toBe(connected)
}

function visibleElements(content: any): any[] {
	return (content?.elements ?? []).filter((element: any) => !element.isDeleted)
}

// A shared board with a text that its owner deletes while the other user's session is offline
async function prepareDeletionWhileOffline(page: Page, browser: Browser) {
	await page.addInitScript(enableTestHooks)
	await openFilesApp(page)
	const boardName = `Deleted elements ${Date.now()}`
	await createWhiteboard(page, { name: boardName })
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)
	await openWhiteboardFromFiles(page, storedName)
	const authPromise = captureBoardAuthFromSave(page, { containsText: DELETED_TEXT })
	await addTextElement(page, DELETED_TEXT)
	const auth = await authPromise

	const otherUser = await createRandomUser()
	await createUserShare(page, { fileName: storedName, shareWith: otherUser.userId, permissions: 15 })
	const context = await browser.newContext({ baseURL: `${new URL(page.url()).origin}/index.php/` })
	await context.addInitScript(enableTestHooks)
	const otherPage = await context.newPage()
	await login(otherPage.request, otherUser)
	await openWhiteboardFromFiles(otherPage, storedName, { preferSharedView: true })
	await expect.poll(() => isInRoom(otherPage), { timeout: 30000, intervals: [500] }).toBe(true)
	await setConnected(otherPage, false)

	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 200, y: 200 }, force: true })
	await page.keyboard.press('ControlOrMeta+A')
	await page.keyboard.press('Delete')
	await expect.poll(async () => JSON.stringify(visibleElements(await fetchBoardContent(page, auth))), { timeout: 20000, intervals: [500] })
		.not.toContain(DELETED_TEXT)

	return { auth, otherPage }
}

// The other session comes back with its copy from before the deletion and edits the board
async function expectStaysDeleted(page: Page, otherPage: Page, auth: { fileId: number, jwt: string }) {
	await setConnected(otherPage, true)
	await otherPage.getByTitle(/^Rectangle/).locator('div').click()
	const box = await (await getCanvasForInteraction(otherPage)).boundingBox()
	if (!box) {
		throw new Error('Canvas not found')
	}
	await otherPage.mouse.move(box.x + 300, box.y + 450)
	await otherPage.mouse.down()
	await otherPage.mouse.move(box.x + 380, box.y + 510, { steps: 5 })
	await otherPage.mouse.up()

	const stored = async () => visibleElements(await fetchBoardContent(page, auth))
	await expect.poll(async () => (await stored()).some((element) => element.type === 'rectangle'), { timeout: 30000, intervals: [500] }).toBe(true)
	expect(JSON.stringify(await stored())).not.toContain(DELETED_TEXT)
	// Sessions also resend their whole board every 20 seconds
	await page.waitForTimeout(25000)
	expect(JSON.stringify(await stored())).not.toContain(DELETED_TEXT)
	await otherPage.context().close()
}

test('a deleted element stays deleted after a comment is added', async ({ page, browser }) => {
	test.setTimeout(180000)
	const { auth, otherPage } = await prepareDeletionWhileOffline(page, browser)

	await page.locator('.comment-trigger').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 400, y: 300 } })
	await page.locator('.comment-popover textarea').fill('Comment after the deletion')
	await page.locator('.comment-popover .comment-popover__button').click()
	await expect.poll(async () => JSON.stringify(visibleElements(await fetchBoardContent(page, auth))), { timeout: 30000, intervals: [500] })
		.toContain('Comment after the deletion')

	await expectStaysDeleted(page, otherPage, auth)
})

test('a deleted element stays deleted after voting results are added', async ({ page, browser }) => {
	test.setTimeout(240000)
	const { auth, otherPage } = await prepareDeletionWhileOffline(page, browser)

	await page.getByTestId('main-menu-trigger').click()
	await page.getByRole('button', { name: 'Votings', exact: true }).click()
	await page.getByRole('button', { name: /start new voting/i }).click()
	const votingDialog = page.getByRole('dialog', { name: /start new voting/i }).last()
	await votingDialog.getByLabel(/question/i).fill('Voting after the deletion')
	await votingDialog.getByLabel(/option 1/i).fill('Red')
	await votingDialog.getByLabel(/option 2/i).fill('Blue')
	await votingDialog.getByRole('button', { name: /Start voting/i }).click()
	await page.getByText('Red').locator('..').getByRole('button', { name: /vote/i }).click()
	await page.getByRole('button', { name: /end voting/i }).click()
	await page.getByRole('button', { name: /add as drawing/i }).click()
	await expect.poll(async () => JSON.stringify(visibleElements(await fetchBoardContent(page, auth))), { timeout: 30000, intervals: [500] })
		.toContain('Voting after the deletion')

	await expectStaysDeleted(page, otherPage, auth)
})
