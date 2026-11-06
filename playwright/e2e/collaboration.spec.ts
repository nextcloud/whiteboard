/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Page, WebSocketRoute } from '@playwright/test'

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

// Pastes a PNG of random pixels, which PNG cannot compress, and returns its size
async function pasteNoiseImage(page: Page, side: number): Promise<number> {
	await (await getCanvasForInteraction(page)).click({ position: { x: 500, y: 300 } })
	return page.evaluate(async (side) => {
		const canvas = document.createElement('canvas')
		canvas.width = side
		canvas.height = side
		const context = canvas.getContext('2d')!
		const pixels = context.createImageData(side, side)
		for (let i = 0; i < pixels.data.length; i += 4) {
			pixels.data[i] = Math.random() * 256
			pixels.data[i + 1] = Math.random() * 256
			pixels.data[i + 2] = Math.random() * 256
			pixels.data[i + 3] = 255
		}
		context.putImageData(pixels, 0, 0)
		const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), 'image/png'))
		const data = new DataTransfer()
		data.items.add(new File([blob], 'noise.png', { type: 'image/png' }))
		document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
		return blob.size
	}, side)
}

const imageFileSizes = (page: Page) => page.evaluate(() => {
	const api = (window as any).__whiteboardTestHooks?.excalidrawStore?.getState().excalidrawAPI
	if (!api) {
		throw new Error('The test hooks of the editor are missing')
	}
	return Object.values(api.getFiles()).map((file: any) => file.dataURL?.length ?? 0)
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

test('a dropped connection is shown until the board reconnects', async ({ page }) => {
	const connections: WebSocketRoute[] = []
	await page.routeWebSocket(/socket\.io/, (connection) => {
		connection.connectToServer()
		connections.push(connection)
	})

	await createWhiteboard(page, { name: `Dropped connection ${Date.now()}` })
	const status = page.locator('.network-status')
	await expect(status).toHaveCount(0, { timeout: 30000 })

	await connections.at(-1)?.close()

	await expect(status).toBeVisible()
	await expect(status).toHaveCount(0, { timeout: 30000 })
	expect(connections.length).toBeGreaterThan(1)
})

test('shares an image above the old limit of the collaboration server with a session that is already open', async ({ page, browser }) => {
	test.setTimeout(120000)
	const boardName = `Large image ${Date.now()}`
	await createWhiteboard(page, { name: boardName })

	const pageB = await newLoggedInPage(page, browser)
	await pageB.addInitScript(() => {
		;(window as any).__whiteboardTest = true
	})
	await openFilesApp(pageB)
	await openWhiteboardFromFiles(pageB, boardName)
	await expect.poll(() => pageB.evaluate(() => (window as any).__whiteboardTestHooks?.collaborationStore?.getState().isInRoom), { timeout: 30000 }).toBe(true)

	// Above the 2.25 MB the 3 MB message limit of the default server used to carry, below the 2.74 MB it carries now
	const size = await pasteNoiseImage(page, 830)
	expect(size).toBeGreaterThan(2.26e6)
	expect(size).toBeLessThan(2.74e6)

	await expect.poll(() => imageFileSizes(pageB), { timeout: 30000, intervals: [500] }).toEqual([expect.any(Number)])
	expect((await imageFileSizes(pageB))[0]).toBeGreaterThan(size)
	// The image element of the scene shows the received file
	await expect.poll(() => pageB.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		const files = api.getFiles()
		return api.getSceneElements().filter((element: any) => element.type === 'image' && files[element.fileId]).length
	}), { timeout: 30000, intervals: [500] }).toBe(1)

	await pageB.close()
})

test('refuses an image the collaboration server cannot pass on, and says so', async ({ page }) => {
	let rewritten = 0
	await page.routeWebSocket(/socket\.io/, (connection) => {
		const server = connection.connectToServer()
		server.onMessage((message) => {
			if (typeof message === 'string' && message.startsWith('0{') && message.includes('"maxPayload"')) {
				rewritten++
				connection.send(message.replace(/"maxPayload":\d+/, '"maxPayload":200000'))
				return
			}
			connection.send(message)
		})
	})
	await page.addInitScript(() => {
		;(window as any).__whiteboardTest = true
	})
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Image over the limit ${Date.now()}` })
	await expect.poll(() => page.evaluate(() => (window as any).__whiteboardTestHooks?.whiteboardConfigStore?.getState().collabMaxMessageBytes), { timeout: 30000 }).toBe(200000)
	expect(rewritten).toBeGreaterThan(0)

	const size = await pasteNoiseImage(page, 300)
	expect(size).toBeGreaterThan(150000)

	await expect(page.getByText(/File is too big/)).toBeVisible({ timeout: 15000 })
	expect(await imageFileSizes(page)).toEqual([])
})
