/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Properties ${Date.now()}` })
	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 600, y: 400 } })
	await page.keyboard.press('r')
})

test('the selected option has a border that the others lack', async ({ page }) => {
	const style = (title: string) => page.getByTitle(title, { exact: true }).evaluate((label) => {
		const { backgroundColor, borderColor, borderStyle, borderWidth } = getComputedStyle(label)
		return { backgroundColor, borderColor, borderStyle, borderWidth, active: label.classList.contains('active') }
	})
	const thin = await style('Thin')
	const bold = await style('Bold')

	expect(thin.active).toBe(true)
	expect(thin.borderStyle).toBe('solid')
	expect(parseFloat(thin.borderWidth)).toBeGreaterThan(0)
	expect(thin.borderColor).not.toBe(thin.backgroundColor)
	expect(bold.active).toBe(false)
	expect(bold.borderColor).not.toBe(thin.borderColor)
})
