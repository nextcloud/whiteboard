/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

export async function openFilesApp(page: Page) {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
	const newButton = page.getByRole('button', { name: 'New' })
	await expect(newButton).toBeVisible({ timeout: 30000 })
	await expect(newButton).toBeEnabled({ timeout: 30000 })
}

export async function getCanvasForInteraction(page: Page) {
	const interactive = page.locator('.excalidraw__canvas.interactive')
	await interactive.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
	if (await interactive.count()) {
		return interactive.first()
	}
	return page.locator('.excalidraw__canvas').first()
}

export async function waitForCanvas(page: Page, { timeout = 60000 }: { timeout?: number } = {}) {
	const loading = page.getByText('Loading whiteboard...')
	if (await loading.count()) {
		await expect(loading).toBeHidden({ timeout })
	}
	const canvas = page.locator('.excalidraw__canvas').first()
	await expect(canvas).toBeVisible({ timeout })
	await dismissRecordingNotice(page)
}

export async function createWhiteboard(page: Page, { name }: { name?: string } = {}): Promise<string> {
	const boardName = name ?? `Whiteboard ${Date.now()}`
	const newButton = page.getByRole('button', { name: 'New' })
	await expect(newButton).toBeVisible({ timeout: 30000 })
	await newButton.click()

	const menuItem = page.getByRole('menuitem', { name: 'New whiteboard' })
	await expect(menuItem).toBeVisible({ timeout: 30000 })
	await menuItem.click()

	const nameField = page.getByRole('textbox', { name: /name/i })
	if (await nameField.count()) {
		await nameField.fill(boardName)
	} else {
		await page.keyboard.type(boardName)
	}

	const createButton = page.getByRole('button', { name: 'Create' }).first()
	if (await createButton.count()) {
		await createButton.click()
	}
	try {
		await waitForCanvas(page, { timeout: 20000 })
	} catch (error) {
		await openFilesApp(page)
		await openWhiteboardFromFiles(page, boardName)
	}

	return boardName
}

type Point = { x: number, y: number }

type OpenWhiteboardFromFilesOptions = {
	preferSharedView?: boolean
}

export async function addTextElement(page: Page, text: string, point: Point = { x: 600, y: 400 }): Promise<Point> {
	await page.getByTitle(/^Text/).locator('div').click()
	const canvas = await getCanvasForInteraction(page)
	let clickPoint = point
	if (await canvas.count()) {
		const box = await canvas.boundingBox()
		if (box) {
			clickPoint = {
				x: Math.min(box.width - 10, Math.max(10, point.x)),
				y: Math.min(box.height - 10, Math.max(10, point.y)),
			}
			await page.mouse.click(box.x + clickPoint.x, box.y + clickPoint.y, { force: true })
		} else {
			await canvas.click({ position: point, force: true })
		}
	} else {
		await page.getByText('Drawing canvas').click({ position: point, force: true })
	}

	const textArea = page.locator('textarea').first()
	for (let i = 0; i < 4; i++) {
		if (await textArea.isVisible()) {
			break
		}
		await page.waitForTimeout(300)
		if (await canvas.count()) {
			await canvas.click({ position: clickPoint, force: true })
		}
	}
	await expect(textArea).toBeVisible({ timeout: 8000 })
	await textArea.fill(text)

	await finalizeTextEditing(page)
	await expect(page.locator('.excalidraw-textEditorContainer textarea')).toBeHidden({ timeout: 5000 })

	return point
}

export async function openWhiteboardFromFiles(page: Page, name: string, options: OpenWhiteboardFromFilesOptions = {}) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const viewOrder = options.preferSharedView
		? ['apps/files?view=sharingin', 'apps/files/shareoverview', 'apps/files']
		: ['apps/files', 'apps/files/shareoverview']

	const attemptFindEntry = async () => {
		const searchBox = page.getByRole('searchbox', { name: /search here/i }).first()
		if (await searchBox.count()) {
			await searchBox.fill(name)
			await searchBox.press('Enter')
		}
		const candidates = [
			page.locator(`[data-entryname="${name}"]`).first(),
			page.locator(`[data-file="${name}"]`).first(),
			page.getByRole('row', { name: new RegExp(escaped, 'i') }).first(),
		]

		for (let attempt = 0; attempt < 60; attempt++) {
			for (const locator of candidates) {
				if (await locator.count()) {
					return locator
				}
			}
			await page.waitForTimeout(500)
		}
		return null
	}

	const visitView = async (path: string) => {
		await page.goto(path)
		await page.waitForURL(/apps\/files/, { timeout: 20000 }).catch(() => {})
		return attemptFindEntry()
	}

	let entry: ReturnType<Page['locator']> | null = null
	for (const path of viewOrder) {
		entry = await visitView(path)
		if (entry) {
			break
		}
	}


	if (!entry) {
		throw new Error(`Whiteboard file not found: ${name}`)
	}

	await expect(entry).toBeVisible({ timeout: 15000 })

	const viewButton = entry.getByRole('button', { name: /view|open/i }).first()
	if (await viewButton.count()) {
		await viewButton.click()
	} else {
		const target = entry.getByRole('link', { name: new RegExp(escaped, 'i') }).first()
		if (await target.count()) {
			await target.click()
		} else {
			await entry.dblclick()
		}
	}

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

export async function fetchBoardContent(page: Page, auth: { fileId: number | string, jwt: string }) {
	const token = auth.jwt.startsWith('Bearer ') ? auth.jwt : `Bearer ${auth.jwt}`
	const maxAttempts = 5
	const retryDelayMs = 500

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const response = await page.request.get(`apps/whiteboard/${auth.fileId}`, {
			headers: { Authorization: token },
		})

		if (response.ok()) {
			const body = await response.json()
			return body.data
		}

		const status = response.status()
		const text = await response.text().catch(() => '')
		const isLock = status === 409 || status === 423 || text.includes('locked')

		if (attempt < maxAttempts - 1 && isLock) {
			await page.waitForTimeout(retryDelayMs)
			continue
		}

		expect(response.ok()).toBeTruthy()
	}

	// Should never be reached, keep type expectations satisfied
	throw new Error('Failed to fetch board content after retries')
}

export async function captureBoardAuthFromSave(
	page: Page,
	{ containsText }: { containsText?: string } = {},
): Promise<{ fileId: number, jwt: string, apiPath: string }> {
	const saveResponse = await page.waitForResponse((response) => {
		const request = response.request()
		if (request.method() !== 'PUT') {
			return false
		}
		if (!response.url().includes('/apps/whiteboard/')) {
			return false
		}
		if (!containsText) {
			return true
		}
		return (request.postData() || '').includes(containsText)
	}, { timeout: 45000 })

	const authHeader = saveResponse.request().headers()['authorization']
	if (!authHeader) {
		throw new Error('Missing Authorization header on whiteboard save')
	}

	const apiPath = new URL(saveResponse.url()).pathname.replace('/index.php/', '')
	const parts = apiPath.split('/')
	const fileId = Number(parts.pop())
	if (!fileId || Number.isNaN(fileId)) {
		throw new Error(`Could not parse fileId from ${apiPath}`)
	}

	return { fileId, jwt: authHeader, apiPath }
}

export async function resolveStoredFileName(page: Page, displayName: string) {
	const fileRow = page.getByRole('row', { name: new RegExp(displayName) })
	await expect(fileRow).toBeVisible({ timeout: 30000 })

	const rawName = await fileRow.evaluate<string | null>((row) => {
		const element = row as HTMLElement
		const dataEntry = element.getAttribute('data-entryname') || element.getAttribute('data-file')
		if (dataEntry) {
			return dataEntry
		}

		const ariaLabel = element.getAttribute('aria-label') || ''
		const ariaMatch = ariaLabel.match(/file \"([^\"]+)\"/)
		if (ariaMatch?.[1]) {
			return ariaMatch[1]
		}

		const text = element.textContent || ''
		const textMatch = text.match(/([\w\s.-]+\.whiteboard|[\w\s.-]+\.excalidraw)/i)
		if (textMatch?.[1]) {
			return textMatch[1]
		}
		return null
	})

	if (!rawName) {
		throw new Error(`Could not resolve stored file name for ${displayName}`)
	}

	return rawName.trim().replace(/\s+(\.[^.]+)$/, '$1')
}

export async function createUserShare(page: Page, { fileName, shareWith, permissions }: { fileName: string, shareWith: string, permissions: number }) {
	const requestToken = await page.evaluate(() => (window as any).OC?.requestToken
		|| (document.querySelector('head meta[name="requesttoken"]') as HTMLMetaElement)?.content
		|| null)
	const baseOrigin = new URL(await page.url()).origin

	const candidates = (() => {
		const lower = fileName.toLowerCase()
		if (lower.endsWith('.whiteboard') || lower.endsWith('.excalidraw')) {
			return [fileName]
		}
		return [`${fileName}.whiteboard`, `${fileName}.excalidraw`, fileName]
	})()

	let lastApiError: string | null = null
	for (const candidate of candidates) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await page.request.post(`${baseOrigin}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
				form: {
					path: candidate,
					shareType: '0',
					shareWith,
					permissions: String(permissions),
				},
				headers: {
					'OCS-APIREQUEST': 'true',
					...(requestToken ? { requesttoken: requestToken } : {}),
					Accept: 'application/json',
				},
			})
			const data = await response.json().catch(() => null)
			const metaStatus = data?.ocs?.meta?.statuscode
			const shareId = data?.ocs?.data?.id
			if (metaStatus === 200 && shareId) {
				return shareId
			}
			lastApiError = JSON.stringify({
				status: response.status(),
				meta: data?.ocs?.meta,
			})

			const altResponse = await page.request.post(`${baseOrigin}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
				form: {
					path: `/${candidate}`,
					shareType: '0',
					shareWith,
					permissions: String(permissions),
				},
				headers: {
					'OCS-APIREQUEST': 'true',
					...(requestToken ? { requesttoken: requestToken } : {}),
					Accept: 'application/json',
				},
			})
			const altData = await altResponse.json().catch(() => null)
			const altStatus = altData?.ocs?.meta?.statuscode
			const altShareId = altData?.ocs?.data?.id
			if (altStatus === 200 && altShareId) {
				return altShareId
			}
			lastApiError = JSON.stringify({
				status: altResponse.status(),
				meta: altData?.ocs?.meta,
			})

			await page.waitForTimeout(500)
		}
	}

	// UI fallback inside Files app
	const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const row = page.locator(`[data-entryname="${fileName}"], [data-file="${fileName}"]`).first()
	const fallbackRow = row.count().then(count => count > 0 ? row : page.getByRole('row', { name: new RegExp(escaped, 'i') }).first())
	const targetRow = await fallbackRow
	await expect(targetRow).toBeVisible({ timeout: 30000 })

	const shareButton = async () => {
		const primary = targetRow.getByRole('button', { name: /sharing options|share/i }).first()
		if (await primary.count()) {
			return primary
		}
		return targetRow.getByRole('button', { name: /actions/i }).first()
	}

	const buttonToClick = await shareButton()
	await buttonToClick.click()

	const sharingTab = page.getByRole('tab', { name: /Sharing/i }).first()
	if (await sharingTab.count()) {
		await sharingTab.click()
	}

	const shareInputCandidates = () => [
		page.getByRole('textbox', { name: /Share|users or groups|Name or email|internal recipients|external recipients/i }).first(),
		page.getByRole('combobox', { name: /Share|users or groups|internal recipients|external recipients|Name or email/i }).first(),
	]

	let shareInput: ReturnType<Page['locator']> | null = null
	for (let attempt = 0; attempt < 5; attempt++) {
		for (const candidate of shareInputCandidates()) {
			if (await candidate.count()) {
				shareInput = candidate
				break
			}
		}
		if (shareInput) {
			break
		}
		await page.waitForTimeout(500)
	}

	if (!shareInput) {
		throw new Error(`Could not find sharing input field${lastApiError ? ` (API: ${lastApiError})` : ''}`)
	}

	await expect(shareInput).toBeVisible({ timeout: 20000 })
	await shareInput.fill(shareWith)
	await page.waitForTimeout(300)
	const suggestion = page.getByRole('option', { name: new RegExp(shareWith, 'i') }).first()
	if (await suggestion.count()) {
		await suggestion.click()
	} else {
		await page.keyboard.press('Enter')
	}

	const sharedEntry = page.getByText(shareWith, { exact: false }).first()
	if (await sharedEntry.count()) {
		await expect(sharedEntry).toBeVisible({ timeout: 20000 })
	}

	const saveShareButton = page.getByRole('button', { name: /save share/i }).first()
	if (await saveShareButton.count()) {
		await saveShareButton.click()
	}

	const canEditToggle = page.getByRole('checkbox', { name: /can edit/i }).first()
	if (await canEditToggle.count()) {
		const shouldEdit = permissions >= 15
		const isChecked = await canEditToggle.isChecked()
		if (shouldEdit !== isChecked) {
			await canEditToggle.click()
		}
	}

	return 'ui-fallback'
}
