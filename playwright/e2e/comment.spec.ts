/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { captureBoardAuthFromSave, createWhiteboard, fetchBoardContent, getCanvasForInteraction, openFilesApp } from '../support/utils'

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
