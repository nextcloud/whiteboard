/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

const createdBoardIds = new Map<string, number>()

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
		try {
			const { fileId } = await getBoardAuth(page)
			createdBoardIds.set(boardName, fileId)
		} catch {
			// ignore, fallback resolution handles it
		}
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
	const fileName = normalizeWhiteboardFileName(name)
	await ensureFilesBaseUrl(page, options.preferSharedView)
	if (await tryOpenWhiteboardInViewer(page, fileName)) {
		await waitForCanvas(page)
		return
	}

	const cachedId = createdBoardIds.get(name)
	const fileId = cachedId ?? await resolveFileIdByName(page, name, {
		preferSharedView: options.preferSharedView,
	})
	await openWhiteboardById(page, fileId)
	await waitForCanvas(page)
}

type ResolveFileIdOptions = {
	preferSharedView?: boolean
}

async function resolveFileIdByName(page: Page, displayName: string, options: ResolveFileIdOptions = {}) {
	const filesUrl = await ensureFilesBaseUrl(page, options.preferSharedView)
	const origin = new URL(filesUrl).origin
	const basePath = getBasePathFromUrl(filesUrl)
	const baseOrigins = basePath ? [`${origin}${basePath}`, origin] : [origin]
	const userId = await resolveCurrentUserId(page, baseOrigins[0])
	const requestToken = await getRequestToken(page)

	const candidates = new Set<string>()
	const addCandidate = (value: string | null) => {
		if (!value) {
			return
		}
		candidates.add(value)
	}

	const rowInfo = await tryResolveFileInfoFromRow(page, displayName)
	if (rowInfo?.fileId) {
		return rowInfo.fileId
	}
	addCandidate(rowInfo?.fileName ?? null)

	const lower = displayName.toLowerCase()
	if (lower.endsWith('.whiteboard') || lower.endsWith('.excalidraw')) {
		addCandidate(displayName)
	} else {
		addCandidate(`${displayName}.whiteboard`)
		addCandidate(`${displayName}.excalidraw`)
		addCandidate(displayName)
	}

	const propfindBody = `<?xml version="1.0"?>\n<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">\n  <d:prop>\n    <oc:fileid />\n  </d:prop>\n</d:propfind>\n`
	const candidateList = Array.from(candidates)

	for (let attempt = 0; attempt < 6; attempt++) {
		for (const candidate of candidateList) {
			const appFileId = await tryResolveFileIdFromFilesApp(page, candidate)
			if (appFileId) {
				return appFileId
			}
		}

		for (const baseOrigin of baseOrigins) {
			const listingId = await fetchFileIdFromWebDavListing(page, baseOrigin, userId, candidateList, propfindBody, requestToken)
			if (listingId) {
				return listingId
			}
		}

		for (const candidate of candidateList) {
			for (const baseOrigin of baseOrigins) {
				const fileId = await fetchFileIdFromWebDav(page, baseOrigin, userId, candidate, propfindBody, requestToken)
				if (fileId) {
					return fileId
				}
			}
		}

		await page.waitForTimeout(400)
	}

	throw new Error(`Whiteboard file not found via WebDAV: ${displayName}`)
}

async function resolveCurrentUserId(page: Page, baseUrl?: string) {
	const origin = baseUrl ?? new URL(await ensureFilesBaseUrl(page)).origin
	const requestToken = await getRequestToken(page)
	const response = await page.request.get(`${origin}/ocs/v2.php/cloud/user?format=json`, {
		headers: {
			'OCS-APIREQUEST': 'true',
			...(requestToken ? { requesttoken: requestToken } : {}),
			Accept: 'application/json',
		},
	}).catch(() => null)
	const data = response ? await response.json().catch(() => null) : null
	let userId = data?.ocs?.data?.id
	if (!userId) {
		userId = await page.evaluate(() => (window as any).OC?.getCurrentUser?.()?.uid
			|| (window as any).OCP?.User?.userId
			|| null)
	}
	if (!userId) {
		userId = await page.evaluate(() => {
			const selector = '[aria-label*="Avatar of"], [title*="Avatar of"]'
			const element = document.querySelector(selector) as HTMLElement | null
			const label = element?.getAttribute('aria-label')
				|| element?.getAttribute('title')
				|| element?.textContent
				|| ''
			const match = label.match(/Avatar of\\s+([^—-]+)/)
			return match?.[1]?.trim() || null
		})
	}
	if (!userId) {
		throw new Error('Could not resolve current user id from OCS')
	}
	return String(userId)
}

async function fetchFileIdFromWebDav(
	page: Page,
	baseUrl: string,
	userId: string,
	fileName: string,
	propfindBody: string,
	requestToken?: string | null,
) {
	const path = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/${encodeURIComponent(fileName)}`
	const response = await page.request.fetch(path, {
		method: 'PROPFIND',
		headers: {
			Depth: '0',
			'Content-Type': 'application/xml',
			...(requestToken ? { requesttoken: requestToken } : {}),
		},
		data: propfindBody,
		timeout: 4000,
	})

	if (!response.ok()) {
		return null
	}

	const text = await response.text()
	const match = text.match(/<oc:fileid[^>]*>(\d+)<\/oc:fileid>/i)
	if (!match?.[1]) {
		return null
	}
	const fileId = Number(match[1])
	return Number.isNaN(fileId) ? null : fileId
}

async function fetchFileIdFromWebDavListing(
	page: Page,
	baseUrl: string,
	userId: string,
	fileNames: string[],
	propfindBody: string,
	requestToken?: string | null,
) {
	const path = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/`
	const response = await page.request.fetch(path, {
		method: 'PROPFIND',
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml',
			...(requestToken ? { requesttoken: requestToken } : {}),
		},
		data: propfindBody,
		timeout: 4000,
	}).catch(() => null)

	if (!response || !response.ok()) {
		return null
	}

	const nameSet = new Set(fileNames.map((name) => name.toLowerCase()))
	const text = await response.text().catch(() => '')
	const responses = text.split(/<d:response[^>]*>/i).slice(1)
	for (const block of responses) {
		const hrefMatch = block.match(/<d:href[^>]*>([^<]+)<\/d:href>/i)
		const fileIdMatch = block.match(/<oc:fileid[^>]*>(\d+)<\/oc:fileid>/i)
		if (!hrefMatch?.[1] || !fileIdMatch?.[1]) {
			continue
		}
		const decoded = safeDecodeURIComponent(hrefMatch[1])
		const name = decoded.split('/').pop() || ''
		if (!name || !nameSet.has(name.toLowerCase())) {
			continue
		}
		const fileId = Number(fileIdMatch[1])
		return Number.isNaN(fileId) ? null : fileId
	}
	return null
}

function safeDecodeURIComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

async function ensureFilesBaseUrl(page: Page, preferSharedView = false) {
	const viewOrder = preferSharedView
		? ['apps/files?view=sharingin', 'apps/files/shareoverview', 'apps/files']
		: ['apps/files', 'apps/files/shareoverview']

	for (const path of viewOrder) {
		try {
			await page.goto(path)
			await page.waitForURL(/apps\/files/, { timeout: 20000 })
			return page.url()
		} catch {
			// keep trying
		}
	}

	const current = page.url()
	if (!current || current === 'about:blank') {
		await page.goto('apps/files')
	}
	return page.url()
}

function normalizeWhiteboardFileName(name: string) {
	const lower = name.toLowerCase()
	if (lower.endsWith('.whiteboard') || lower.endsWith('.excalidraw')) {
		return name
	}
	return `${name}.whiteboard`
}

async function tryOpenWhiteboardInViewer(page: Page, fileName: string) {
	const path = fileName.startsWith('/') ? fileName : `/${fileName}`
	const viewerReady = await page.waitForFunction(() => Boolean((window as any).OCA?.Viewer?.open), { timeout: 5000 })
		.then(() => true)
		.catch(() => false)
	if (!viewerReady) {
		return false
	}

	await ensureWhiteboardViewerHandler(page)

	const opened = await page.evaluate((filePath) => {
		const viewer = (window as any).OCA?.Viewer
		if (!viewer?.open) {
			return false
		}
		viewer.open({ path: filePath })
		return true
	}, path).catch(() => false)

	return Boolean(opened)
}

async function ensureWhiteboardViewerHandler(page: Page) {
	await page.evaluate(async () => {
		const hasHandler = () => {
			const handlers = (window as any)._oca_viewer_handlers
			if (!handlers) {
				return false
			}
			if (typeof handlers.has === 'function') {
				return handlers.has('whiteboard')
			}
			return Boolean((handlers as Record<string, unknown>).whiteboard)
		}

		if (hasHandler()) {
			return true
		}

		const base = (window as any).OC?.webroot || ''
		const url = (window as any).OC?.generateUrl?.('/apps/whiteboard/js/whiteboard-main.mjs')
			|| (window as any).OC?.linkTo?.('whiteboard', 'js/whiteboard-main.mjs')
			|| `${base}/apps/whiteboard/js/whiteboard-main.mjs`

		await new Promise<void>((resolve, reject) => {
			const script = document.createElement('script')
			script.type = 'module'
			script.src = url
			script.addEventListener('load', () => resolve())
			script.addEventListener('error', () => reject(new Error('Failed to load whiteboard viewer script')))
			document.head.appendChild(script)
		}).catch(() => {})

		return hasHandler()
	}).catch(() => null)
}

function getBasePathFromUrl(url: string) {
	try {
		const parsed = new URL(url)
		const indexPos = parsed.pathname.indexOf('/index.php')
		if (indexPos === -1) {
			return ''
		}
		return parsed.pathname.slice(0, indexPos + '/index.php'.length)
	} catch {
		return ''
	}
}

async function tryResolveFileIdFromFilesApp(page: Page, fileName: string) {
	const fileId = await page.evaluate((name) => {
		const app = (window as any).OCA?.Files?.App
		const fileList = app?.currentFileList || app?.fileList
		if (!fileList) {
			return null
		}
		let info = fileList.getFileInfo?.(name) || null
		const files = fileList.files
		if (!info && files) {
			if (typeof files.findWhere === 'function') {
				info = files.findWhere({ name }) || null
			} else if (Array.isArray(files)) {
				info = files.find((entry: any) => entry?.name === name || entry?.attributes?.name === name) || null
			} else if (typeof files.get === 'function') {
				info = files.get(name) || null
			} else if (Array.isArray(files.models)) {
				info = files.models.find((entry: any) => entry?.attributes?.name === name || entry?.get?.('name') === name) || null
			} else if (typeof files === 'object') {
				const direct = (files as Record<string, any>)[name]
				if (direct) {
					info = direct
				} else {
					const values = Object.values(files as Record<string, any>)
					info = values.find((entry: any) => entry?.name === name || entry?.attributes?.name === name) || null
				}
			}
		}
		const normalized = info?.attributes ?? info
		const id = info?.id ?? info?.fileid ?? info?.fileId ?? null
		const normalizedId = normalized?.id ?? normalized?.fileid ?? normalized?.fileId ?? null
		const resolvedId = id ?? normalizedId ?? null
		if (resolvedId === null || resolvedId === undefined) {
			return null
		}
		const parsed = Number(resolvedId)
		return Number.isNaN(parsed) ? null : parsed
	}, fileName).catch(() => null)
	return fileId ?? null
}

async function getRequestToken(page: Page) {
	return page.evaluate(() => (window as any).OC?.requestToken
		|| (document.querySelector('head meta[name="requesttoken"]') as HTMLMetaElement)?.content
		|| null).catch(() => null)
}

async function tryResolveFileInfoFromRow(page: Page, displayName: string) {
	const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const fileRow = page.getByRole('row', { name: new RegExp(escaped, 'i') }).first()
	try {
		await fileRow.waitFor({ state: 'visible', timeout: 5000 })
	} catch {
		return null
	}

	const info = await fileRow.evaluate<{ fileId: string | null, fileName: string | null }>((row) => {
		const element = row as HTMLElement
		const dataset = (element as HTMLElement & { dataset?: Record<string, string> }).dataset || {}
		const idCandidate = element.querySelector('[data-id], [data-fileid], [data-file-id], [data-entry-id]') as HTMLElement | null
		const fileId = element.getAttribute('data-id')
			|| element.getAttribute('data-fileid')
			|| element.getAttribute('data-file-id')
			|| element.getAttribute('data-entry-id')
			|| idCandidate?.getAttribute('data-id')
			|| idCandidate?.getAttribute('data-fileid')
			|| idCandidate?.getAttribute('data-file-id')
			|| idCandidate?.getAttribute('data-entry-id')
			|| dataset.fileid
			|| dataset.id
			|| null

		const dataEntry = element.getAttribute('data-entryname') || element.getAttribute('data-file')
		if (dataEntry) {
			return { fileId, fileName: dataEntry }
		}

		const ariaLabel = element.getAttribute('aria-label') || ''
		const ariaMatch = ariaLabel.match(/file \"([^\"]+)\"/)
		if (ariaMatch?.[1]) {
			return { fileId, fileName: ariaMatch[1] }
		}

		const text = element.textContent || ''
		const textMatch = text.match(/([\w\s.-]+\.whiteboard|[\w\s.-]+\.excalidraw)/i)
		if (textMatch?.[1]) {
			return { fileId, fileName: textMatch[1] }
		}
		return { fileId, fileName: null }
	})

	if (!info) {
		return null
	}

	const cleanedName = info.fileName?.trim().replace(/\s+(\.[^.]+)$/, '$1') ?? null
	const numericId = info.fileId ? Number(info.fileId) : null
	return {
		fileId: numericId && !Number.isNaN(numericId) ? numericId : null,
		fileName: cleanedName,
	}
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
	await page.goto(`apps/files/files/${fileId}?openfile=true`)
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
