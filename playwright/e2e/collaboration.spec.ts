/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { WebSocketRoute } from '@playwright/test'

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	createWhiteboard,
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
