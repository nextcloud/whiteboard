/**
 * SPDX-FileCopyrightText: 2025 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'
import { captureBoardAuthFromSave, createWhiteboard, fetchBoardContent, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('Add reaction Button', async ({ page }) => {
	const boardName = `Emoji ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	await page.getByRole('button', { name: 'Add reaction', exact: true }).click()
	await expect(page.getByRole('dialog', {  name: 'Emoji picker' })).toBeVisible()

	await page.getByRole('region', { name: 'Smileys & Emotion' }).getByLabel('😀, grinning').click()
	await expect(page.getByRole('dialog', {  name: 'Emoji picker' })).not.toBeVisible()
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({
		position: {
			x: 534,
			y: 249,
		},
	})
	await expect(page.getByText('EdgesOpacity')).toBeVisible()
})

test('the place an emoji is dropped at reaches the server', async ({ page }) => {
	test.slow()
	await createWhiteboard(page, { name: `Emoji place ${Date.now()}` })

	await page.getByRole('button', { name: 'Add reaction', exact: true }).click()
	const insertSave = captureBoardAuthFromSave(page, { containsText: '"type":"image"' })
	await page.getByRole('region', { name: 'Smileys & Emotion' }).getByLabel('😀, grinning').click()
	const auth = await insertSave

	const storedPosition = async () => {
		const { elements } = await fetchBoardContent(page, auth)
		const emoji = elements.find((element: { type: string, isDeleted?: boolean }) => element.type === 'image' && !element.isDeleted)
		return { x: Math.round(emoji.x), y: Math.round(emoji.y) }
	}
	const inserted = await storedPosition()

	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 534, y: 249 } })
	await expect.poll(storedPosition, { timeout: 30000 }).not.toEqual(inserted)
})
