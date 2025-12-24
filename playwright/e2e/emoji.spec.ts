/**
 * SPDX-FileCopyrightText: 2025 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

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
