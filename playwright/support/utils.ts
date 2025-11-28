/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

export async function openFilesApp(page: Page) {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
}

export async function waitForCanvas(page: Page) {
	await expect(page.getByText('Drawing canvas')).toBeVisible({ timeout: 20000 })
	await dismissRecordingNotice(page)
}

export async function createWhiteboard(page: Page, { name }: { name?: string } = {}) {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()

	if (name) {
		const nameField = page.getByRole('textbox', { name: /name/i })
		if (await nameField.count()) {
			await nameField.fill(name)
		} else {
			await page.keyboard.type(name)
		}
	}

	await page.getByRole('button', { name: 'Create' }).click()
	await waitForCanvas(page)
}

type Point = { x: number, y: number }

export async function addTextElement(page: Page, text: string, point: Point = { x: 320, y: 260 }): Promise<Point> {
	await page.getByTitle(/^Text/).locator('div').click()
	await page.getByText('Drawing canvas').click({ position: point })

	const textArea = page.locator('textarea').first()
	await textArea.fill(text)

	await finalizeTextEditing(page)
	await expect(page.locator('.excalidraw-textEditorContainer textarea')).toBeHidden({ timeout: 5000 })

	return point
}

export async function openWhiteboardFromFiles(page: Page, name: string) {
	await openFilesApp(page)
	const candidates = [
		page.getByTitle(name),
		page.getByTitle(`${name}.whiteboard`),
		page.getByTitle(`${name}.excalidraw`),
		page.getByText(name, { exact: false }),
	]

	let entry: ReturnType<Page['locator']> | null = null
	for (const locator of candidates) {
		if (await locator.count()) {
			entry = locator
			break
		}
	}

	if (!entry) {
		throw new Error(`Whiteboard file not found: ${name}`)
	}

	await expect(entry).toBeVisible({ timeout: 10000 })
	await entry.click()
	await waitForCanvas(page)
}

export async function newLoggedInPage(sourcePage: Page, browser: Browser) {
	const baseOrigin = new URL(await sourcePage.url()).origin
	const storageState = await sourcePage.context().storageState()
	const context = await browser.newContext({
		baseURL: `${baseOrigin}/index.php/`,
		storageState,
	})
	const page = await context.newPage()
	return page
}

export async function finalizeTextEditing(page: Page) {
	const editor = page.locator('.excalidraw-textEditorContainer textarea').first()
	if (await editor.count()) {
		await editor.press('Escape')
		await expect(editor).toBeHidden({ timeout: 5000 })
	}
}

export async function dismissRecordingNotice(page: Page) {
	const notice = page.locator('.recording-unavailable')
	if (await notice.count()) {
		const dismissButton = notice.getByRole('button', { name: 'Dismiss' })
		if (await dismissButton.count()) {
			await dismissButton.click({ timeout: 2000 }).catch(() => {})
		}
		await notice.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
	}
}

export async function getBoardAuth(page: Page): Promise<{ fileId: number, jwt: string }> {
	await page.waitForFunction(() => {
		const load = window.OCP?.InitialState?.loadState
		return Boolean(load && load('whiteboard', 'file_id') && load('whiteboard', 'jwt'))
	}, { timeout: 20000 })

	const { fileId, jwt } = await page.evaluate(() => {
		const load = window.OCP?.InitialState?.loadState
		return {
			fileId: load ? Number(load('whiteboard', 'file_id')) : null,
			jwt: load ? String(load('whiteboard', 'jwt') || '') : null,
		}
	})

	if (!fileId || !jwt) {
		throw new Error('Whiteboard initial state missing identifiers')
	}

	return { fileId, jwt }
}

export async function openWhiteboardById(page: Page, fileId: number | string) {
	await page.goto(`apps/whiteboard/${fileId}`)
	await waitForCanvas(page)
}
