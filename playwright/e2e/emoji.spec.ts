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

test('an emoji keeps its colors on a dark board', async ({ page }) => {
	await page.addInitScript(() => {
		;(window as any).__whiteboardTest = true
	})
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Emoji colors ${Date.now()}` })
	const menu = page.locator('.excalidraw').getByRole('button', { name: 'Menu', exact: true })
	await menu.click()
	await page.getByRole('menuitem', { name: 'Dark mode' }).click()
	await menu.click()
	await expect(page.locator('.excalidraw.theme--dark')).toBeVisible()

	await page.getByRole('button', { name: 'Add reaction', exact: true }).click()
	const insertSave = captureBoardAuthFromSave(page, { containsText: '"type":"image"' })
	await page.getByRole('region', { name: 'Smileys & Emotion' }).getByLabel('😀, grinning').click()
	const auth = await insertSave
	await (await getCanvasForInteraction(page)).click({ position: { x: 534, y: 249 } })

	const { elements } = await fetchBoardContent(page, auth)
	const emoji = elements.find((element: { type: string, isDeleted?: boolean }) => element.type === 'image' && !element.isDeleted)
	expect(emoji.customData).toMatchObject({ keepColorsInDarkMode: true })

	// yellow pixels of the emoji on the editor canvas; dark mode would invert them to a dark brown
	const yellowPixels = () => page.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks?.excalidrawStore?.getState().excalidrawAPI
		const image = api?.getSceneElements().find((element: { type: string }) => element.type === 'image')
		const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
		if (!image || !canvas) {
			return -1
		}
		const { scrollX, scrollY, zoom } = api.getAppState()
		const ratio = canvas.width / canvas.clientWidth
		const { data } = canvas.getContext('2d')!.getImageData(
			Math.round((image.x + scrollX) * zoom.value * ratio),
			Math.round((image.y + scrollY) * zoom.value * ratio),
			Math.round(image.width * zoom.value * ratio),
			Math.round(image.height * zoom.value * ratio),
		)
		let yellow = 0
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] > 200 && data[i + 1] > 150 && data[i + 2] < 100) {
				yellow++
			}
		}
		return yellow / (data.length / 4)
	})
	await expect.poll(yellowPixels).toBeGreaterThan(0.3)

	// the same image without the flag is inverted
	await page.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		api.updateScene({
			elements: api.getSceneElements().map((element: { type: string, version: number, customData: object }) => element.type === 'image'
				? { ...element, customData: { ...element.customData, keepColorsInDarkMode: false }, version: element.version + 1 }
				: element),
		})
	})
	await expect.poll(yellowPixels).toBeLessThan(0.05)
})
