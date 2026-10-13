/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createWhiteboard,
	getCanvasForInteraction,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardFromFiles,
	fetchBoardContent,
	getBoardAuth,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('whiteboard changes sync across sessions', async ({ page, browser, user }) => {
	test.setTimeout(90000)
	const boardName = `Collab board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'First session text')

	let auth
	try {
		auth = await getBoardAuth(page)
	} catch {
		const saveResp = await page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/apps/whiteboard/'), { timeout: 60000 })
		const authHeader = saveResp.request().headers()['authorization'] || ''
		const apiPath = new URL(saveResp.url()).pathname.replace('/index.php/', '')
		const fileId = Number(apiPath.split('/').pop())
		auth = { fileId, jwt: authHeader }
	}

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 20000,
		interval: 500,
	}).toContain('First session text')

	const pageB = await newLoggedInPage(page, browser)
	await openWhiteboardFromFiles(pageB, boardName)
	const fetchContent = async (targetPage) => JSON.stringify(await fetchBoardContent(targetPage, auth))

	await expect.poll(async () => fetchContent(pageB), { timeout: 20000, interval: 500 }).toContain('First session text')

	await addTextElement(pageB, 'Second session text')

	await expect.poll(async () => fetchContent(page), { timeout: 30000, interval: 500 }).toContain('Second session text')

	await pageB.close()
})

test('shows images to a session that joins later', async ({ page, browser }) => {
	test.setTimeout(120000)
	const boardName = `Collab image ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await (await getCanvasForInteraction(page)).click({ position: { x: 500, y: 300 } })
	const saved = captureBoardAuthFromSave(page, { containsText: 'image/png' })
	await page.evaluate(async () => {
		const canvas = document.createElement('canvas')
		canvas.width = 160
		canvas.height = 90
		const context = canvas.getContext('2d')!
		context.fillStyle = '#2a9d8f'
		context.fillRect(0, 0, 160, 90)
		const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), 'image/png'))
		const data = new DataTransfer()
		data.items.add(new File([blob], 'image.png', { type: 'image/png' }))
		document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
	})
	await saved

	const pageB = await newLoggedInPage(page, browser)
	await pageB.addInitScript(() => {
		;(window as any).__whiteboardTest = true
	})
	await openFilesApp(pageB)
	await openWhiteboardFromFiles(pageB, boardName)

	// color in the middle of the image on the editor canvas; a missing image shows a gray placeholder
	await expect.poll(() => pageB.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks?.excalidrawStore?.getState().excalidrawAPI
		const image = api?.getSceneElements().find((element: { type: string }) => element.type === 'image')
		const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
		if (!image || !canvas) {
			return null
		}
		const { scrollX, scrollY, zoom } = api.getAppState()
		const ratio = canvas.width / canvas.clientWidth
		const x = Math.round((image.x + image.width / 2 + scrollX) * zoom.value * ratio)
		const y = Math.round((image.y + image.height / 2 + scrollY) * zoom.value * ratio)
		return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data.slice(0, 3)).join(',')
	}), { timeout: 20000, intervals: [500] }).toBe('42,157,143')

	await pageB.close()
})
