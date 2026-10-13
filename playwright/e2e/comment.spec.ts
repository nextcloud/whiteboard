/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { captureBoardAuthFromSave, createWhiteboard, fetchBoardContent, getCanvasForInteraction, newLoggedInPage, openFilesApp, openWhiteboardFromFiles } from '../support/utils'

type BoardContent = {
	elements?: Array<{ isDeleted?: boolean, customData?: { type?: string, commentThread?: { comments: Array<{ text: string }> } } }>
}

function commentTexts(content: BoardContent): string[] {
	return (content.elements ?? [])
		.filter((element) => !element.isDeleted && element.customData?.type === 'comment')
		.flatMap((element) => element.customData?.commentThread?.comments.map((comment) => comment.text) ?? [])
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('create comment and reply', async ({ page }) => {
	const boardName = `Comment ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	await page.locator('.comment-trigger').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: { x: 400, y: 300 },
	})

	await expect(page.locator('.comment-popover')).toBeVisible()

	await page.locator('.comment-popover textarea').fill('First comment')
	await page.locator('.comment-popover .comment-popover__button').click()

	await expect(page.locator('.comment-popover')).toContainText('First comment')

	await page.locator('.comment-popover textarea').fill('Reply comment')
	await page.locator('.comment-popover .comment-popover__button').click()

	await expect(page.locator('.comment-popover')).toContainText('First comment')
	await expect(page.locator('.comment-popover')).toContainText('Reply comment')
	await expect(page.locator('.comment-pin')).toBeVisible()
})

test('replies and edits of a saved comment reach the server', async ({ page }) => {
	test.slow()
	await createWhiteboard(page, { name: `Comment save ${Date.now()}` })

	await page.locator('.comment-trigger').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: { x: 400, y: 300 },
	})
	await page.locator('.comment-popover textarea').fill('First comment')
	const firstSave = captureBoardAuthFromSave(page, { containsText: 'First comment' })
	await page.locator('.comment-popover .comment-popover__button').click()
	const auth = await firstSave

	await page.locator('.comment-popover textarea').fill('Reply comment')
	await page.locator('.comment-popover .comment-popover__button').click()
	await expect.poll(async () => commentTexts(await fetchBoardContent(page, auth)), { timeout: 30000 })
		.toEqual(['First comment', 'Reply comment'])

	await page.locator('.comment-popover__item-header .comment-popover__menu-button').first().click()
	await page.locator('.comment-popover__menu-dropdown button', { hasText: 'Edit' }).click()
	await page.locator('.comment-popover__edit textarea').fill('Edited comment')
	await page.locator('.comment-popover__edit-actions button', { hasText: 'Save' }).click()
	await expect.poll(async () => commentTexts(await fetchBoardContent(page, auth)), { timeout: 30000 })
		.toEqual(['Edited comment', 'Reply comment'])
})

test('deleting a saved comment thread reaches other sessions and the server', async ({ page, browser }) => {
	test.slow()
	const boardName = `Comment delete ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	await page.locator('.comment-trigger').click()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: { x: 400, y: 300 },
	})
	await page.locator('.comment-popover textarea').fill('Comment to delete')
	const firstSave = captureBoardAuthFromSave(page, { containsText: 'Comment to delete' })
	await page.locator('.comment-popover .comment-popover__button').click()
	const auth = await firstSave
	await expect.poll(async () => commentTexts(await fetchBoardContent(page, auth)), { timeout: 30000 }).toEqual(['Comment to delete'])

	const pageB = await newLoggedInPage(page, browser)
	await openWhiteboardFromFiles(pageB, boardName)
	await expect(pageB.locator('.comment-pin')).toHaveCount(1, { timeout: 30000 })

	await page.locator('.comment-popover__header-actions .comment-popover__menu-button').click()
	await page.locator('.comment-popover__header-menu button', { hasText: 'Delete thread' }).click()

	await expect(pageB.locator('.comment-pin')).toHaveCount(0, { timeout: 30000 })
	await expect.poll(async () => commentTexts(await fetchBoardContent(page, auth)), { timeout: 30000 }).toEqual([])

	await pageB.close()
})
