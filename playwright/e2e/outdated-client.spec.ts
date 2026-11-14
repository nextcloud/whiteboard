/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Page } from '@playwright/test'

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user.ts'
import {
	addTextElement,
	createWhiteboard,
	fetchBoardContent,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardById,
} from '../support/utils.ts'

function enableTestHooks() {
	(window as any).__whiteboardTest = true
}

function boardAuth(page: Page) {
	return page.evaluate(() => {
		const fileId = Number((window as any).__whiteboardTestHooks.whiteboardConfigStore.getState().fileId)
		const tokens = JSON.parse(window.localStorage.getItem('jwt-storage') || '{}').state?.tokens || {}
		return { fileId, jwt: String(tokens[fileId]) }
	})
}

async function storedTexts(page: Page, auth: { fileId: number, jwt: string }) {
	return ((await fetchBoardContent(page, auth)).elements ?? [])
		.filter((element: any) => element.type === 'text' && !element.isDeleted)
		.map((element: any) => element.text)
		.sort()
}

function shownTexts(page: Page) {
	return page.evaluate(() => (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		.getSceneElements()
		.filter((element: any) => element.type === 'text')
		.map((element: any) => element.text)
		.sort())
}

test.beforeEach(async ({ page }) => {
	await page.addInitScript(enableTestHooks)
	await openFilesApp(page)
})

test('refuses the whole-scene save of an older client and keeps the board', async ({ page }) => {
	await createWhiteboard(page, { name: `Older client ${Date.now()}` })
	await addTextElement(page, 'Saved by the current client')
	const auth = await boardAuth(page)
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Saved by the current client'])

	// The scene an older tab still holds: it lacks the saved text
	for (const schemaVersion of [undefined, 2]) {
		const response = await page.request.put(`apps/whiteboard/${auth.fileId}`, {
			headers: { Authorization: `Bearer ${auth.jwt}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
			data: { data: { elements: [], files: {} }, schemaVersion },
		})
		expect(response.status()).toBe(400)
		expect((await response.json()).code).toBe('client_upgrade_required')
	}
	expect(await storedTexts(page, auth)).toEqual(['Saved by the current client'])
})

test('ignores the scene messages of an older client', async ({ page, browser }) => {
	await createWhiteboard(page, { name: `Older peer ${Date.now()}` })
	const auth = await boardAuth(page)
	const other = await newLoggedInPage(page, browser)
	await other.addInitScript(enableTestHooks)
	await openWhiteboardById(other, auth.fileId)
	await page.waitForFunction(() => (window as any).__whiteboardTestHooks?.collaborationStore?.getState().isInRoom, undefined, { timeout: 30000 })
	await other.waitForFunction(() => (window as any).__whiteboardTestHooks?.collaborationStore?.getState().isInRoom, undefined, { timeout: 30000 })

	await addTextElement(page, 'Template text')
	await expect.poll(() => shownTexts(other), { timeout: 30000 }).toEqual(['Template text'])
	// As a 3.0 beta tab sends it: a whole scene with the previous schema marker
	await page.evaluate((fileId) => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		const template = api.getSceneElements()[0]
		const element = { ...template, id: 'from-an-older-tab', text: 'From an older tab', originalText: 'From an older tab', version: template.version + 10 }
		const socket = (window as any).__whiteboardTestHooks.collaborationStore.getState().socket
		for (const schemaVersion of [undefined, 2]) {
			socket.emit('server-broadcast', `${fileId}`, new TextEncoder().encode(JSON.stringify({ type: 'SCENE_UPDATE', schemaVersion, payload: { elements: [element] } })), [])
		}
	}, auth.fileId)

	await other.waitForTimeout(3000)
	expect(await shownTexts(other)).toEqual(['Template text'])
	await other.context().close()
})

test('keeps the unsaved draft of the previous client on the device and adds it back when asked', async ({ page }) => {
	test.setTimeout(120000)
	await createWhiteboard(page, { name: `Draft of the previous client ${Date.now()}` })
	await addTextElement(page, 'Saved')
	const auth = await boardAuth(page)
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Saved'])

	// What the previous client left in IndexedDB: its whole scene, with a change it could not save
	await page.evaluate(async (fileId) => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		const template = api.getSceneElements()[0]
		const draft = { ...template, id: 'drawn-before-the-update', text: 'Drawn before the update', originalText: 'Drawn before the update', y: template.y + 100 }
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('WhiteboardDatabase', 10)
			request.onupgradeneeded = () => request.result.createObjectStore('whiteboards', { keyPath: 'id', autoIncrement: true })
			request.onerror = () => reject(request.error)
			request.onsuccess = () => {
				const transaction = request.result.transaction('whiteboards', 'readwrite')
				transaction.objectStore('whiteboards').put({ id: fileId, elements: [template, draft], files: {}, hasPendingLocalChanges: true, savedAt: Date.now() })
				transaction.oncomplete = () => {
					request.result.close()
					resolve()
				}
			}
		})
	}, auth.fileId)

	await openWhiteboardById(page, auth.fileId)
	const notice = page.getByRole('status').getByText(/Some changes on this device were not saved/)
	await expect(notice).toBeVisible({ timeout: 30000 })
	expect(await shownTexts(page)).toEqual(['Saved'])

	await notice.click()
	await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual(['Drawn before the update', 'Saved'])
	await expect.poll(() => storedTexts(page, auth), { timeout: 30000 }).toEqual(['Drawn before the update', 'Saved'])
})
