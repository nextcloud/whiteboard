/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Buffer } from 'buffer'
import { expect } from '@playwright/test'
import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { test } from '../support/fixtures/random-user'
import {
	createUserShare,
	openFilesApp,
	resolveStoredFileName,
	openWhiteboardFromFiles,
	waitForCanvas,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('following a collaborator requests viewport sync', async ({ page, browser }) => {
	test.setTimeout(150000)
	const boardName = `Follow board ${Date.now()}`

	await page.addInitScript(() => {
		;(window as any).__whiteboardTest = true
		;(window as any).__whiteboardTestHooks = (window as any).__whiteboardTestHooks || {}
	})

	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	const nameField = page.getByRole('textbox', { name: /name/i })
	if (await nameField.count()) {
		await nameField.fill(boardName)
	} else {
		await page.keyboard.type(boardName)
	}
	await page.getByRole('button', { name: 'Create' }).click()
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)

	const followerUser = await createRandomUser()
	await createUserShare(page, {
		fileName: storedName,
		shareWith: followerUser.userId,
		permissions: 15,
	})

	await openWhiteboardFromFiles(page, storedName)
	await waitForCanvas(page, { timeout: 30000 })

	const baseOrigin = new URL(await page.url()).origin
	const ownerInfoResponse = await page.request.get(`${baseOrigin}/ocs/v2.php/cloud/user?format=json`, {
		headers: { 'OCS-APIREQUEST': 'true' },
	})
	const ownerInfo = await ownerInfoResponse.json().catch(async () => {
		return { raw: await ownerInfoResponse.text() }
	})
	const ownerUserId = ownerInfo?.ocs?.data?.id
	if (!ownerUserId) {
		throw new Error(`Could not resolve owner user id (${ownerInfoResponse.status()} ${JSON.stringify(ownerInfo)})`)
	}

	const followerContext = await browser.newContext({
		baseURL: `${baseOrigin}/index.php/`,
		storageState: undefined,
	})
	await followerContext.addInitScript(() => {
		;(window as any).__whiteboardTest = true
		;(window as any).__whiteboardTestHooks = (window as any).__whiteboardTestHooks || {}
	})
	const followerPage = await followerContext.newPage()

	const requestViewportFrames: string[] = []
	followerPage.on('websocket', (socket) => {
		if (!socket.url().includes('/socket.io/')) {
			return
		}

		socket.on('framesent', (payload) => {
			const raw = typeof payload === 'string'
				? payload
				: (payload as { payload?: unknown; data?: unknown }).payload
					|| (payload as { payload?: unknown; data?: unknown }).data
					|| payload
			if (typeof raw !== 'string' && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer)) {
				return
			}
			const frame = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8')
			if (!frame.startsWith('42')) {
				return
			}
			try {
				const event = JSON.parse(frame.slice(2))
				if (Array.isArray(event) && event[0] === 'request-viewport') {
					requestViewportFrames.push(frame)
				}
			} catch {
				return
			}
		})
	})

	await login(followerPage.request, followerUser)
	await openWhiteboardFromFiles(followerPage, storedName, { preferSharedView: true })
	await waitForCanvas(followerPage, { timeout: 30000 })

	const fileId = await followerPage.evaluate(() => {
		const hooks = (window as any).__whiteboardTestHooks
		const fromStore = hooks?.whiteboardConfigStore?.getState?.().fileId
		if (fromStore) {
			return Number(fromStore)
		}
		try {
			const load = window.OCP?.InitialState?.loadState
			return load ? Number(load('whiteboard', 'file_id')) : null
		} catch {
			return null
		}
	})
	if (!fileId) {
		throw new Error('Could not resolve whiteboard file id for follower')
	}

	await followerPage.waitForFunction(() => {
		const store = (window as any).__whiteboardTestHooks?.collaborationStore
		const state = store?.getState?.()
		return Boolean(state?.socket?.connected && state?.isInRoom)
	}, { timeout: 30000 })

	await followerPage.evaluate(({ userId, fileId }) => {
		const store = (window as any).__whiteboardTestHooks?.collaborationStore
		const socket = store?.getState?.().socket
		if (!socket) {
			throw new Error('Collaboration socket not available')
		}
		socket.emit('request-viewport', { fileId: String(fileId), userId })
	}, { userId: ownerUserId, fileId })

	await expect.poll(() => requestViewportFrames.length, {
		timeout: 20000,
		interval: 500,
	}).toBeGreaterThan(0)

	await followerPage.close()
	await followerContext.close()
})
