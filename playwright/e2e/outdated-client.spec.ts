/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Page } from '@playwright/test'

import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	openFilesApp,
	openWhiteboardFromFiles,
	resolveStoredFileName,
} from '../support/utils'

function enableTestHooks() {
	(window as any).__whiteboardTest = true
}

function collaborationState(page: Page, key: string) {
	return page.evaluate((key) => {
		return (window as any).__whiteboardTestHooks.collaborationStore.getState()[key]
	}, key)
}

async function waitForRoom(page: Page) {
	await page.waitForFunction(() => {
		const state = (window as any).__whiteboardTestHooks?.collaborationStore?.getState()
		return Boolean(state?.socket?.connected && state.isInRoom)
	}, undefined, { timeout: 30000 })
}

// a scene broadcast without the schema marker, as clients older than 3.0 send it
async function sendOutdatedScene(page: Page, fileId: number) {
	await page.evaluate((fileId) => {
		const socket = (window as any).__whiteboardTestHooks.collaborationStore.getState().socket
		const scene = new TextEncoder().encode(JSON.stringify({ type: 'SCENE_UPDATE', payload: { elements: [] } }))
		socket.emit('server-broadcast', `${fileId}`, scene, [])
	}, fileId)
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

for (const sameAccount of [false, true]) {
	const saver = sameAccount ? 'the elected saver (same account as the outdated client)' : 'a fallback saver'
	test(`${saver} keeps what others saved while it was disconnected`, async ({ page, browser }) => {
		test.setTimeout(180000)
		await page.addInitScript(enableTestHooks)

		const boardName = await createWhiteboard(page, { name: `Outdated client ${Date.now()}` })
		await openFilesApp(page)
		const storedName = await resolveStoredFileName(page, boardName)
		const editor = await createRandomUser()
		await createUserShare(page, { fileName: storedName, shareWith: editor.userId, permissions: 15 })

		// the owner joins first and stands in for the outdated client: it is the elected saver but does not save
		await openWhiteboardFromFiles(page, storedName)
		await waitForRoom(page)
		await page.evaluate(() => {
			(window as any).__whiteboardTestHooks.collaborationStore.setState({ isDedicatedSyncer: false })
		})
		const auth = await page.evaluate(() => {
			const fileId = Number((window as any).__whiteboardTestHooks.whiteboardConfigStore.getState().fileId)
			const tokens = JSON.parse(window.localStorage.getItem('jwt-storage') || '{}').state?.tokens || {}
			return { fileId, jwt: String(tokens[fileId]) }
		})
		const boardContent = async () => JSON.stringify(await fetchBoardContent(page, auth))

		const baseURL = `${new URL(page.url()).origin}/index.php/`
		const openBoard = async (asOwner: boolean) => {
			const context = await browser.newContext({ baseURL, storageState: asOwner ? await page.context().storageState() : undefined })
			await context.addInitScript(enableTestHooks)
			const boardPage = await context.newPage()
			if (!asOwner) {
				await login(boardPage.request, editor)
			}
			await openWhiteboardFromFiles(boardPage, storedName, { preferSharedView: !asOwner })
			await waitForRoom(boardPage)
			return boardPage
		}
		const first = await openBoard(sameAccount)
		const second = await openBoard(false)
		expect(await collaborationState(first, 'isDedicatedSyncer')).toBe(sameAccount)

		await sendOutdatedScene(page, auth.fileId)
		await expect.poll(() => collaborationState(first, 'hasOutdatedPeer')).toBe(true)
		await expect.poll(() => collaborationState(second, 'hasOutdatedPeer')).toBe(true)

		// the first client loses the connection and misses what the second one saves
		const saves: string[] = []
		first.on('request', (request) => {
			if (request.method() === 'PUT' && request.url().includes(`/apps/whiteboard/${auth.fileId}`)) {
				saves.push(request.url())
			}
		})
		await first.evaluate(() => {
			const { socket } = (window as any).__whiteboardTestHooks.collaborationStore.getState()
			socket.io.reconnection(false)
			socket.io.engine.close()
		})
		await expect.poll(() => collaborationState(first, 'status')).not.toBe('online')

		await addTextElement(second, 'Saved while away')
		await expect.poll(boardContent, { timeout: 30000, intervals: [500] }).toContain('Saved while away')
		expect(await collaborationState(first, 'status')).not.toBe('online')
		await second.context().close()

		// loading the saved board fails until released, and the first client draws meanwhile
		let blockLoads = true
		let failedLoads = 0
		await first.route(`**/apps/whiteboard/${auth.fileId}`, async (route) => {
			if (route.request().method() === 'GET' && blockLoads) {
				failedLoads++
				await route.fulfill({ status: 503 })
				return
			}
			await route.continue()
		})
		await first.evaluate(() => {
			const { socket } = (window as any).__whiteboardTestHooks.collaborationStore.getState()
			socket.io.reconnection(true)
			socket.connect()
		})
		await waitForRoom(first)
		await expect.poll(() => failedLoads).toBeGreaterThan(0)
		await addTextElement(first, 'Drawn after reconnect', { x: 400, y: 250 })
		// longer than the 10 s save interval
		await first.waitForTimeout(11000)
		expect(saves).toHaveLength(0)
		expect(await collaborationState(first, 'pendingServerMerge')).toBe(true)

		blockLoads = false
		await expect.poll(() => collaborationState(first, 'pendingServerMerge'), { timeout: 20000 }).toBe(false)
		await expect.poll(boardContent, { timeout: 30000, intervals: [500] }).toContain('Drawn after reconnect')
		expect(await boardContent()).toContain('Saved while away')

		await first.context().close()
	})
}
