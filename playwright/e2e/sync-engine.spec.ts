/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Browser, BrowserContext, Page, Route } from '@playwright/test'

import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user.ts'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardById,
	openWhiteboardFromFiles,
	resolveStoredFileName,
} from '../support/utils.ts'

type Auth = { fileId: number, jwt: string }

const boardRequest = /\/apps\/whiteboard\/\d+(\?.*)?$/

function enableTestHooks() {
	(window as any).__whiteboardTest = true
}

type SocketControl = {
	dead: boolean
	drop?: (packet: string, toServer: boolean) => boolean
}

/**
 * The socket of the page passes every message until `dead` is set; then it
 * drops them both ways without closing, as behind a proxy after the device
 * slept. `drop` drops single Socket.IO packets (a packet and its binary
 * attachments go or stay together).
 */
async function controlSocket(page: Page): Promise<SocketControl> {
	const control: SocketControl = { dead: false }
	await page.routeWebSocket(/socket\.io/, (ws) => {
		const server = ws.connectToServer()
		const pipe = (send: (message: string | Buffer) => void, toServer: boolean) => {
			let pending: { frames: (string | Buffer)[], missing: number } | null = null
			const flush = (frames: (string | Buffer)[]) => {
				const packet = frames.map((frame) => frame.toString()).join('')
				if (!control.drop?.(packet, toServer)) {
					frames.forEach(send)
				}
			}
			return (message: string | Buffer) => {
				if (control.dead) {
					return
				}
				if (pending) {
					pending.frames.push(message)
					if (--pending.missing === 0) {
						const { frames } = pending
						pending = null
						flush(frames)
					}
					return
				}
				const attachments = typeof message === 'string' ? message.match(/^45(\d+)-/) : null
				if (attachments && Number(attachments[1]) > 0) {
					pending = { frames: [message], missing: Number(attachments[1]) }
					return
				}
				flush([message])
			}
		}
		ws.onMessage(pipe((message) => server.send(message), true))
		server.onMessage(pipe((message) => ws.send(message), false))
	})
	return control
}

/** Holds the board saves of the page until released; `active` turns holding on and off */
async function holdSaves(target: Page | BrowserContext) {
	const held: Route[] = []
	const state = { active: false }
	await target.route(boardRequest, async (route) => {
		if (route.request().method() !== 'PUT' || !state.active) {
			await route.fallback()
			return
		}
		held.push(route)
	})
	return {
		state,
		held,
		/** Sends the held saves to the server now, after anything sent meanwhile */
		release: async () => {
			state.active = false
			for (const route of held.splice(0)) {
				const response = await route.fetch()
				await route.fulfill({ response }).catch(() => {})
			}
		},
	}
}

function sceneElements(page: Page): Promise<any[]> {
	return page.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks?.excalidrawStore?.getState().excalidrawAPI
		return api ? JSON.parse(JSON.stringify(api.getSceneElementsIncludingDeleted())) : []
	})
}

function visibleTexts(elements: any[]): string[] {
	return elements
		.filter((element) => element.type === 'text' && !element.isDeleted)
		.map((element) => element.text)
		.sort()
}

async function storedTexts(page: Page, auth: Auth) {
	return visibleTexts((await fetchBoardContent(page, auth))?.elements ?? [])
}

async function shownTexts(page: Page) {
	return visibleTexts(await sceneElements(page))
}

function isInRoom(page: Page) {
	return page.evaluate(() => {
		const state = (window as any).__whiteboardTestHooks?.collaborationStore?.getState()
		return Boolean(state?.socket?.connected && state.isInRoom)
	})
}

/** Creates a board with one saved text and returns its auth and stored name */
async function createBoard(page: Page, text: string) {
	await page.addInitScript(enableTestHooks)
	await openFilesApp(page)
	const boardName = `Sync engine ${Date.now()}`
	await createWhiteboard(page, { name: boardName })
	const saved = captureBoardAuthFromSave(page, { containsText: text })
	await addTextElement(page, text)
	const { fileId, jwt } = await saved
	const auth = { fileId, jwt }
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toContain(text)
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)
	return { auth, storedName }
}

/** Shares the board with a new user and opens it there, in a new browser */
async function openAsOtherUser<T>(page: Page, browser: Browser, storedName: string, beforeOpen: (page: Page) => Promise<T> = async () => undefined as T) {
	const otherUser = await createRandomUser()
	await createUserShare(page, { fileName: storedName, shareWith: otherUser.userId, permissions: 15 })
	const context = await browser.newContext({ baseURL: `${new URL(page.url()).origin}/index.php/` })
	await context.addInitScript(enableTestHooks)
	const otherPage = await context.newPage()
	await login(otherPage.request, otherUser)
	const extra = await beforeOpen(otherPage)
	await openWhiteboardFromFiles(otherPage, storedName, { preferSharedView: true })
	return { otherPage, context, extra }
}

/** Moves the element with this text, as dragging it a few times does */
function moveText(page: Page, text: string, dx: number, times: number) {
	return page.evaluate(({ text, dx, times }) => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		for (let i = 0; i < times; i++) {
			api.updateScene({
				elements: api.getSceneElementsIncludingDeleted().map((element: any) => element.type === 'text' && element.text === text
					? { ...element, x: element.x + dx, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
					: element),
			})
		}
	}, { text, dx, times })
}

function deleteText(page: Page, text: string) {
	return page.evaluate((text) => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		api.updateScene({
			elements: api.getSceneElementsIncludingDeleted().map((element: any) => element.type === 'text' && element.text === text
				? { ...element, isDeleted: true, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
				: element),
		})
	}, text)
}

async function davBase(page: Page) {
	const origin = new URL(page.url()).origin
	const user = await (await page.request.get(`${origin}/ocs/v2.php/cloud/user?format=json`, { headers: { 'OCS-APIREQUEST': 'true' } })).json()
	const requestToken = await page.evaluate(() => (window as any).OC?.requestToken ?? '')
	return { origin, userId: user.ocs.data.id as string, headers: { requesttoken: requestToken, 'X-Requested-With': 'XMLHttpRequest' } }
}

/** The id of the newest version of the file whose content has the text */
async function findVersion(page: Page, fileId: number, text: string) {
	const { origin, userId, headers } = await davBase(page)
	const list = await page.request.fetch(`${origin}/remote.php/dav/versions/${userId}/versions/${fileId}`, {
		method: 'PROPFIND',
		headers: { ...headers, Depth: '1' },
	})
	const ids = [...(await list.text()).matchAll(/versions\/\d+\/(\d+)</g)].map((match) => match[1]).sort().reverse()
	for (const id of ids) {
		const content = await (await page.request.get(`${origin}/remote.php/dav/versions/${userId}/versions/${fileId}/${id}`, { headers })).text()
		if (content.includes(text)) {
			return { origin, userId, id, source: `/remote.php/dav/versions/${userId}/versions/${fileId}/${id}` }
		}
	}
	throw new Error(`No version with ${text}`)
}

test('a tab whose socket died silently keeps what another tab saved, and catches up', async ({ page, browser }) => {
	test.slow()
	const { auth } = await createBoard(page, 'Deleted by the first tab')
	await openWhiteboardById(page, auth.fileId)
	await addTextElement(page, 'Saved before', { x: 300, y: 200 })
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toContain('Saved before')

	// A second tab of the same user
	const deafTab = await newLoggedInPage(page, browser)
	await deafTab.addInitScript(enableTestHooks)
	const socket = await controlSocket(deafTab)
	await openWhiteboardById(deafTab, auth.fileId)
	await expect.poll(() => shownTexts(deafTab), { timeout: 30000 }).toEqual(['Deleted by the first tab', 'Saved before'])

	socket.dead = true
	await addTextElement(page, 'Saved by the first tab', { x: 300, y: 500 })
	await deleteText(page, 'Deleted by the first tab')
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Saved before', 'Saved by the first tab'])

	await addTextElement(deafTab, 'Drawn in the tab that lost its socket', { x: 700, y: 600 })
	const expected = ['Drawn in the tab that lost its socket', 'Saved before', 'Saved by the first tab']
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(expected)
	// Its next saves still keep what the first tab saved
	await deafTab.waitForTimeout(15000)
	expect(await storedTexts(page, auth)).toEqual(expected)
	await expect.poll(() => shownTexts(deafTab), { timeout: 30000 }).toEqual(expected)
	await deafTab.context().close()
})

test('a tab that catches up shows the elements as Nextcloud stored them, in their order', async ({ page, browser }) => {
	test.slow()
	const { auth } = await createBoard(page, 'Below')
	await openWhiteboardById(page, auth.fileId)
	await addTextElement(page, 'Above', { x: 300, y: 300 })
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Above', 'Below'])

	const deafTab = await newLoggedInPage(page, browser)
	await deafTab.addInitScript(enableTestHooks)
	const socket = await controlSocket(deafTab)
	await openWhiteboardById(deafTab, auth.fileId)
	await expect.poll(() => shownTexts(deafTab), { timeout: 30000 }).toEqual(['Above', 'Below'])
	socket.dead = true

	// Two saves: the upper element first, then the lower one
	for (const text of ['Above', 'Below']) {
		await moveText(page, text, 10, 1)
		await page.evaluate(() => (window as any).__whiteboardTestHooks.boardSync.save())
	}
	const stamps = (elements: any[]) => elements.filter((element) => element.type === 'text').map((element) => `${element.text}@${element.version}:${element.versionNonce}:${element.index}`)
	const stored = stamps((await fetchBoardContent(page, auth)).elements)

	await deafTab.evaluate(() => (window as any).__whiteboardTestHooks.boardSync.fetch())
	expect(stamps(await sceneElements(deafTab))).toEqual(stored)
	expect(await deafTab.evaluate(() => (window as any).__whiteboardTestHooks.boardSync.unsavedChanges().elements.length)).toBe(0)
	await deafTab.context().close()
})

test('a save that reaches the server late does not replace a newer one', async ({ page }) => {
	test.slow()
	const { auth } = await createBoard(page, 'Saved at the start')
	await openWhiteboardById(page, auth.fileId)
	const saves = await holdSaves(page.context())

	saves.state.active = true
	await addTextElement(page, 'First edit', { x: 300, y: 300 })
	await expect.poll(() => saves.held.length, { timeout: 30000 }).toBeGreaterThan(0)
	saves.state.active = false
	await addTextElement(page, 'Second edit', { x: 300, y: 500 })
	// Leaving the board sends its last changes while the earlier save is still on its way
	await page.goto('apps/files')

	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toContain('Second edit')
	await saves.release()
	await page.waitForTimeout(2000)
	expect(await storedTexts(page, auth)).toEqual(['First edit', 'Saved at the start', 'Second edit'])
})

test('a restored version wins over a session that kept editing while it was offline', async ({ page, browser }) => {
	test.slow()
	const { auth, storedName } = await createBoard(page, 'In the version')
	await openWhiteboardById(page, auth.fileId)
	await addTextElement(page, 'Added after the version', { x: 300, y: 550 })
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Added after the version', 'In the version'])
	const version = await findVersion(page, auth.fileId, 'In the version').then(async (found) => {
		const content = await (await page.request.get(`${found.origin}${found.source}`)).text()
		return content.includes('Added after the version') ? null : found
	})
	expect(version).not.toBeNull()
	const restoredX = (await fetchBoardContent(page, auth)).elements.find((element: any) => element.text === 'In the version').x

	const { otherPage, context, extra } = await openAsOtherUser(page, browser, storedName, async (other) => ({
		socket: await controlSocket(other),
		saves: await holdSaves(other),
	}))
	await expect.poll(() => isInRoom(otherPage), { timeout: 30000 }).toBe(true)
	await expect.poll(() => shownTexts(otherPage), { timeout: 30000 }).toEqual(['Added after the version', 'In the version'])

	// Offline: no socket, no saves, while it moves the element several times
	extra.socket.dead = true
	extra.saves.state.active = true
	await moveText(otherPage, 'In the version', 40, 12)

	await page.evaluate(({ fileId, source, fileVersion }) => {
		(window as any)._nc_event_bus.emit('files_versions:restore:requested', {
			fileInfo: { id: fileId, mimetype: 'application/vnd.excalidraw+json' },
			version: { source, fileVersion },
		})
	}, { fileId: auth.fileId, source: version!.source, fileVersion: version!.id })
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['In the version'])

	extra.socket.dead = false
	await extra.saves.release()
	await otherPage.waitForTimeout(20000)
	const stored = await fetchBoardContent(page, auth)
	expect(visibleTexts(stored.elements)).toEqual(['In the version'])
	expect(stored.elements.find((element: any) => element.text === 'In the version').x).toBe(restoredX)
	await expect.poll(() => shownTexts(otherPage), { timeout: 60000 }).toEqual(['In the version'])
	await context.close()
})

test('a file uploaded over the board wins over a tab that saves an older scene', async ({ page }) => {
	test.slow()
	const { auth, storedName } = await createBoard(page, 'Before the upload')
	await openWhiteboardById(page, auth.fileId)
	const saves = await holdSaves(page)

	saves.state.active = true
	await addTextElement(page, 'Not saved when the file was replaced', { x: 300, y: 500 })
	await expect.poll(() => saves.held.length, { timeout: 30000 }).toBeGreaterThan(0)

	const board = await fetchBoardContent(page, auth)
	const text = board.elements.find((element: any) => element.text === 'Before the upload')
	const uploaded = {
		...board,
		elements: [{ ...text, id: 'uploadedtext1', text: 'Uploaded board', originalText: 'Uploaded board', version: 1, versionNonce: 1 }],
	}
	const { origin, userId, headers } = await davBase(page)
	const upload = await page.request.put(`${origin}/remote.php/dav/files/${userId}/${encodeURIComponent(storedName)}`, {
		headers,
		data: JSON.stringify(uploaded),
	})
	expect(upload.ok()).toBe(true)

	await saves.release()
	await page.waitForTimeout(15000)
	expect(await storedTexts(page, auth)).toEqual(['Uploaded board'])
	await expect.poll(() => shownTexts(page), { timeout: 60000 }).toEqual(['Uploaded board'])
})

test('edits reach Nextcloud without a collaboration server', async ({ page }) => {
	test.slow()
	const { auth } = await createBoard(page, 'Saved with the collaboration server')
	await page.routeWebSocket(/socket\.io/, (ws) => ws.close())
	await openWhiteboardById(page, auth.fileId)
	await addTextElement(page, 'Saved without it', { x: 300, y: 500 })
	await expect.poll(() => storedTexts(page, auth), { timeout: 45000 }).toEqual(['Saved with the collaboration server', 'Saved without it'])
})

test('an image reaches Nextcloud when the collaboration server lost it', async ({ page, browser }) => {
	test.setTimeout(240000)
	const { auth, storedName } = await createBoard(page, 'Board with an image')
	await openWhiteboardById(page, auth.fileId)
	await expect.poll(() => isInRoom(page), { timeout: 30000 }).toBe(true)
	const { otherPage, context, extra } = await openAsOtherUser(page, browser, storedName, (other) => controlSocket(other))
	extra.drop = (packet, toServer) => toServer && packet.includes('IMAGE_ADD')
	await expect.poll(() => isInRoom(otherPage), { timeout: 30000 }).toBe(true)

	// An image element and its file, as inserting an image creates them
	const imageFileId = `image${Date.now()}`
	await otherPage.evaluate((imageFileId) => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		const template = api.getSceneElements().find((element: any) => element.type === 'text')
		api.addFiles([{ id: imageFileId, mimeType: 'image/png', created: Date.now(), dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }])
		api.updateScene({
			elements: [...api.getSceneElementsIncludingDeleted(), {
				...template,
				id: `${imageFileId}-element`,
				type: 'image',
				fileId: imageFileId,
				status: 'saved',
				scale: [1, 1],
				crop: null,
				x: template.x + 200,
				width: 100,
				height: 100,
				index: 'a9',
				version: 1,
				versionNonce: 7,
				boundElements: null,
				customData: undefined,
			}],
		})
	}, imageFileId)
	await expect.poll(async () => (await fetchBoardContent(page, auth)).elements.some((element: any) => element.fileId === imageFileId), { timeout: 60000 }).toBe(true)

	await expect.poll(async () => Object.keys((await fetchBoardContent(page, auth)).files ?? {}), { timeout: 90000 }).toContain(imageFileId)
	await context.close()
})

test('a tab catches up when the collaboration server delivers no scene messages', async ({ page, browser }) => {
	test.setTimeout(240000)
	const { auth, storedName } = await createBoard(page, 'Before the relay broke')
	await openWhiteboardById(page, auth.fileId)
	const { otherPage, context, extra } = await openAsOtherUser(page, browser, storedName, (other) => controlSocket(other))
	await expect.poll(() => isInRoom(otherPage), { timeout: 30000 }).toBe(true)
	await expect.poll(() => shownTexts(otherPage), { timeout: 30000 }).toEqual(['Before the relay broke'])

	// Connected, but no broadcast reaches the tab, as when the relay's Redis is out of memory
	extra.drop = (packet, toServer) => !toServer && packet.includes('client-broadcast')
	await addTextElement(page, 'Drawn while the relay broke', { x: 300, y: 500 })
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toContain('Drawn while the relay broke')
	await expect.poll(() => shownTexts(otherPage), { timeout: 120000, intervals: [2000] }).toEqual(['Before the relay broke', 'Drawn while the relay broke'])
	await context.close()
})
