/**
 * SPDX-FileCopyrightText: 2025 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
})

test('Add reaction Button', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()

	await page.getByRole('button', { name: 'Add reaction', exact: true }).click()
	await expect(page.getByRole('dialog', {  name: 'Emoji picker' })).toBeVisible()

	await page.getByRole('region', { name: 'Smileys & Emotion' }).getByLabel('😀, grinning').click()
	await expect(page.getByRole('dialog', {  name: 'Emoji picker' })).not.toBeVisible()
	await page.getByText('Drawing canvas').click({
		position: {
			x: 534,
			y: 249,
		},
	})
	await expect(page.getByText('StrokeFont family')).toBeVisible()
})