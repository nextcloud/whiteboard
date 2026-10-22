/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Buffer } from 'buffer'
import { expect, type Browser, type Page } from '@playwright/test'
import { createRandomUser, login } from '@nextcloud/e2e-test-server/playwright'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	getBoardAuth,
	getCanvasForInteraction,
	openFilesApp,
	openWhiteboardFromFiles,
	resolveStoredFileName,
	waitForCanvas,
} from '../support/utils'

const versionPropfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
	<d:prop>
		<d:getlastmodified />
	</d:prop>
</d:propfind>`

const skipWhenVersionContentUnavailable = () => {
	test.skip(
		process.env.SERVER_VERSION === 'stable29',
		'Nextcloud 29 does not expose version content over the versions DAV endpoint',
	)
}

const extractVersionIds = (xml: string, userId: string, fileId: number | string): string[] => {
	const prefix = `/remote.php/dav/versions/${userId}/versions/${fileId}/`
	const hrefRegex = /<[^:>]*:href>([^<]+)<\/[^:>]*:href>/g
	const versionIds = new Set<string>()
	let match: RegExpExecArray | null = null

	while ((match = hrefRegex.exec(xml)) !== null) {
		const href = decodeURIComponent(match[1])
		const index = href.indexOf(prefix)
		if (index === -1) {
			continue
		}
		const remainder = href.slice(index + prefix.length).replace(/\/$/, '')
		if (remainder) {
			versionIds.add(remainder)
		}
	}

	return [...versionIds]
}

const findVersionByContent = async (
	page: Page,
	options: {
		origin: string
		userId: string
		fileId: number
		includeText: string
		excludeText?: string
		accept?: (content: any) => boolean
	},
): Promise<{ versionId: string, versionSource: string }> => {
	const { origin, userId, fileId, includeText, excludeText, accept } = options
	const listUrl = `${origin}/remote.php/dav/versions/${userId}/versions/${fileId}`
	const maxAttempts = 20
	const requestToken = await page.evaluate(() => (window as any).OC?.requestToken
		|| (document.querySelector('head meta[name="requesttoken"]') as HTMLMetaElement | null)?.content
		|| null)
	const versionHeaders = {
		Depth: '1',
		Accept: 'application/xml',
		'Content-Type': 'application/xml',
		...(requestToken ? { requesttoken: requestToken } : {}),
		'X-Requested-With': 'XMLHttpRequest',
	}

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const response = await page.request.fetch(listUrl, {
			method: 'PROPFIND',
			headers: versionHeaders,
			data: versionPropfindBody,
		})

		if (!response.ok()) {
			throw new Error(`Version list request failed with status ${response.status()}`)
		}

		const xml = await response.text()
		const versionIds = extractVersionIds(xml, userId, fileId)

		for (const versionId of versionIds) {
			const versionSource = `/remote.php/dav/versions/${userId}/versions/${fileId}/${versionId}`
			const versionResponse = await page.request.get(`${origin}${versionSource}`, {
				headers: {
					...(requestToken ? { requesttoken: requestToken } : {}),
					'X-Requested-With': 'XMLHttpRequest',
				},
			})
			if (!versionResponse.ok()) {
				continue
			}
			const rawContent = await versionResponse.text()
			if (!rawContent.includes(includeText)) {
				continue
			}
			if (excludeText && rawContent.includes(excludeText)) {
				continue
			}
			if (accept && !accept(JSON.parse(rawContent))) {
				continue
			}
			return { versionId, versionSource }
		}

		await page.waitForTimeout(1000)
	}

	throw new Error(`No matching version found for ${includeText}`)
}

const visibleTexts = (content: any): string[] => (content?.elements ?? [])
	.filter((element: any) => element.type === 'text' && !element.isDeleted)
	.map((element: any) => element.text)
	.sort()

const waitForBoardContent = async (page: Page, auth: { fileId: number, jwt: string }, text: string) => {
	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 20000,
		intervals: [500],
	}).toContain(text)
}

const prepareVersionScenario = async (
	page: Page,
	userId: string,
	options: { boardName: string, initialText: string, updatedText: string },
) => {
	const { boardName, initialText, updatedText } = options
	await createWhiteboard(page, { name: boardName })
	const authPromise = captureBoardAuthFromSave(page, { containsText: initialText })
	await addTextElement(page, initialText)
	const { fileId, jwt } = await authPromise
	const baseAuth = { fileId, jwt }
	await waitForBoardContent(page, baseAuth, initialText)

	await addTextElement(page, updatedText, { x: 720, y: 520 })
	await waitForBoardContent(page, baseAuth, updatedText)

	const origin = new URL(await page.url()).origin
	const versionEntry = await findVersionByContent(page, {
		origin,
		userId,
		fileId: baseAuth.fileId,
		includeText: initialText,
		excludeText: updatedText,
	})

	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)

	return { baseAuth, origin, versionEntry, storedName }
}

const openWhiteboardInViewer = async (
	page: Page,
	options: { fileId: number, fileName: string, source?: string | null, fileVersion?: string | null },
) => {
	// Nextcloud 36 and up: the viewer is part of the server, a version opens
	// from the Versions tab of the file
	const legacyViewer = await page.evaluate(() => Boolean((window as any).OCA?.Viewer?.availableHandlers))
	if (!legacyViewer) {
		await page.locator(`[data-cy-files-list-row-name="${options.fileName}"]`).click({ button: 'right' })
		await page.getByRole('menuitem', { name: /details/i }).first().click()
		await page.getByRole('tab', { name: 'Versions' }).click()
		await page.locator(`.version[data-files-versions-version="${options.fileVersion}"] a`).click()
		return
	}

	const filePath = options.fileName.startsWith('/') ? options.fileName : `/${options.fileName}`
	await page.waitForFunction(() => Boolean((window as any).OCA?.Viewer?.openWith), { timeout: 10000 })
	await page.evaluate(({ fileId, filePathValue, fileName, source, fileVersion }) => {
		const viewer = (window as any).OCA?.Viewer
		if (!viewer?.openWith) {
			throw new Error('Viewer openWith unavailable')
		}
		viewer.openWith('whiteboard', {
			fileInfo: {
				fileid: Number(fileId),
				filename: filePathValue,
				basename: fileName,
				source: source ?? null,
				fileVersion: fileVersion ?? null,
				mime: 'application/vnd.excalidraw+json',
				size: 0,
				type: 'file',
			},
			enableSidebar: false,
		})
	}, {
		fileId: options.fileId,
		filePathValue: filePath,
		fileName: options.fileName,
		source: options.source ?? null,
		fileVersion: options.fileVersion ?? null,
	})
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('version preview banner shows and exits to live board', async ({
	page,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(120000)
	const boardName = `Version preview ${Date.now()}`
	const initialText = 'Version one'
	const updatedText = 'Version two'

	const { baseAuth, versionEntry, storedName } = await prepareVersionScenario(page, user.userId, {
		boardName,
		initialText,
		updatedText,
	})
	await openWhiteboardInViewer(page, {
		fileId: baseAuth.fileId,
		fileName: storedName,
		source: versionEntry.versionSource,
		fileVersion: versionEntry.versionId,
	})
	await waitForCanvas(page)

	const banner = page.locator('.version-preview-banner')
	await expect(banner).toBeVisible({ timeout: 20000 })
	await expect(page.getByRole('button', { name: 'Restore this version' })).toBeVisible()

	const backButton = page.getByRole('button', { name: 'Back to latest version' })
	await expect(backButton).toBeVisible()
	await backButton.click()

	await expect(banner).toBeHidden({ timeout: 20000 })
	await waitForBoardContent(page, baseAuth, updatedText)
})

test('restore version replaces current content', async ({
	page,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(120000)
	const boardName = `Version restore ${Date.now()}`
	const initialText = 'Restore one'
	const updatedText = 'Restore two'

	const { baseAuth, versionEntry, storedName } = await prepareVersionScenario(page, user.userId, {
		boardName,
		initialText,
		updatedText,
	})
	await openWhiteboardInViewer(page, {
		fileId: baseAuth.fileId,
		fileName: storedName,
		source: versionEntry.versionSource,
		fileVersion: versionEntry.versionId,
	})
	await waitForCanvas(page)

	const restoreButton = page.getByRole('button', { name: 'Restore this version' })
	await expect(restoreButton).toBeVisible()
	await restoreButton.click()

	const banner = page.locator('.version-preview-banner')
	await expect(banner).toBeHidden({ timeout: 20000 })

	await expect.poll(async () => visibleTexts(await fetchBoardContent(page, baseAuth)), {
		timeout: 30000,
		intervals: [500],
	}).toEqual([initialText])
})

const enableTestHooks = () => {
	(window as any).__whiteboardTest = true
}

const isInRoom = (page: Page) => page.evaluate(() => {
	const state = (window as any).__whiteboardTestHooks?.collaborationStore?.getState()
	return Boolean(state?.socket?.connected && state.isInRoom)
})

const setConnected = async (page: Page, connected: boolean) => {
	await page.evaluate((connected) => {
		const { socket } = (window as any).__whiteboardTestHooks.collaborationStore.getState()
		socket.io.reconnection(connected)
		if (connected) {
			socket.connect()
		} else {
			socket.io.engine.close()
		}
	}, connected)
	await expect.poll(() => isInRoom(page), { timeout: 30000, intervals: [500] }).toBe(connected)
}

// Holds the first matching request until released; with sendFirst the request
// reaches the server right away and only its response is held, so held() counts
// it once that response is in
const holdRequests = async (page: Page, method: string, url: string, { sendFirst = false } = {}) => {
	let held = 0
	let release = () => {}
	const released = new Promise<void>((resolve) => {
		release = resolve
	})
	await page.route(url, async (route) => {
		if (route.request().method() !== method || held > 0) {
			await route.fallback()
			return
		}
		const response = sendFirst ? await route.fetch() : null
		held++
		await released
		await (response ? route.fulfill({ response }) : route.fallback())
	})
	return { held: () => held, release }
}

const watchReceivedFrames = (page: Page) => {
	const frames: string[] = []
	page.on('websocket', (socket) => {
		socket.on('framereceived', ({ payload }) => {
			frames.push(payload.toString())
		})
	})
	return (text: string) => frames.some((frame) => frame.includes(text))
}

const locallyStoredTexts = (page: Page, fileId: number) => page.evaluate((fileId) => new Promise<string[]>((resolve, reject) => {
	const request = indexedDB.open('WhiteboardDatabase')
	request.onerror = () => reject(request.error)
	request.onsuccess = () => {
		const read = request.result.transaction('whiteboards').objectStore('whiteboards').get(fileId)
		read.onerror = () => reject(read.error)
		read.onsuccess = () => resolve((read.result?.elements ?? [])
			.filter((element: any) => element.type === 'text' && !element.isDeleted)
			.map((element: any) => element.text)
			.sort())
	}
}), fileId)

// A board with a version that has the text "Restore kept", which was deleted
// afterwards, while "Restore added" was added after it
const prepareRestoreScenario = async (page: Page, userId: string) => {
	await page.addInitScript(enableTestHooks)
	await openFilesApp(page)
	const boardName = `Version restore sessions ${Date.now()}`
	await createWhiteboard(page, { name: boardName })
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)
	await openWhiteboardFromFiles(page, storedName)
	const authPromise = captureBoardAuthFromSave(page, { containsText: 'Restore kept' })
	await addTextElement(page, 'Restore kept')
	const auth = await authPromise
	await waitForBoardContent(page, auth, 'Restore kept')

	const canvas = await getCanvasForInteraction(page)
	await canvas.click({ position: { x: 200, y: 200 }, force: true })
	await page.keyboard.press('ControlOrMeta+A')
	await page.keyboard.press('Delete')
	await expect.poll(async () => visibleTexts(await fetchBoardContent(page, auth)), {
		timeout: 20000,
		intervals: [500],
	}).toEqual([])

	await addTextElement(page, 'Restore added', { x: 720, y: 520 })
	await waitForBoardContent(page, auth, 'Restore added')

	const versionEntry = await findVersionByContent(page, {
		origin: new URL(page.url()).origin,
		userId,
		fileId: auth.fileId,
		includeText: 'Restore kept',
		excludeText: 'Restore added',
		accept: (content) => visibleTexts(content).includes('Restore kept'),
	})

	return { auth, storedName, versionEntry }
}

// Another user with whom the board is shared, in a session of their own
const openOtherSession = async (page: Page, browser: Browser, storedName: string) => {
	const otherUser = await createRandomUser()
	await createUserShare(page, { fileName: storedName, shareWith: otherUser.userId, permissions: 15 })
	const context = await browser.newContext({ baseURL: `${new URL(page.url()).origin}/index.php/` })
	await context.addInitScript(enableTestHooks)
	const otherPage = await context.newPage()
	await login(otherPage.request, otherUser)
	await openWhiteboardFromFiles(otherPage, storedName, { preferSharedView: true })
	await expect.poll(() => isInRoom(otherPage), { timeout: 30000, intervals: [500] }).toBe(true)
	return otherPage
}

const restoreFromBanner = async (
	page: Page,
	options: { fileId: number, storedName: string, versionEntry: { versionId: string, versionSource: string } },
	beforeRestore = async () => {},
) => {
	await openFilesApp(page)
	await openWhiteboardInViewer(page, {
		fileId: options.fileId,
		fileName: options.storedName,
		source: options.versionEntry.versionSource,
		fileVersion: options.versionEntry.versionId,
	})
	await waitForCanvas(page)
	await beforeRestore()
	await page.getByRole('button', { name: 'Restore this version' }).click()
	await expect(page.locator('.version-preview-banner')).toBeHidden({ timeout: 20000 })
}

// Restores a version of the open board from the Files sidebar
const requestRestoreFromSidebar = async (page: Page, fileId: number, versionEntry: { versionId: string, versionSource: string }) => {
	const legacyViewer = await page.evaluate(() => Boolean((window as any).OCA?.Viewer?.availableHandlers))
	if (!legacyViewer) {
		await page.getByRole('button', { name: 'Open sidebar' }).click()
		await page.getByRole('tab', { name: 'Versions' }).click()
		await page.locator(`.version[data-files-versions-version="${versionEntry.versionId}"]`)
			.getByRole('button', { name: 'Actions' })
			.click()
		await page.locator('[data-cy-files-versions-version-action="restore"]').click()
		return
	}
	// The sidebar of Nextcloud 32 and older cannot open next to this viewer; send its request
	await page.evaluate(({ fileId, source, fileVersion }) => {
		(window as any)._nc_event_bus.emit('files_versions:restore:requested', {
			fileInfo: { id: fileId, mimetype: 'application/vnd.excalidraw+json' },
			version: { source, fileVersion },
		})
	}, { fileId, source: versionEntry.versionSource, fileVersion: versionEntry.versionId })
}

// A new rectangle: unlike a text click, it never edits an element that lies
// under the cursor in this session's view
const drawRectangle = async (page: Page, point: { x: number, y: number }) => {
	await page.getByTitle(/^Rectangle/).locator('div').click()
	const box = await (await getCanvasForInteraction(page)).boundingBox()
	if (!box) {
		throw new Error('Canvas not found')
	}
	await page.mouse.move(box.x + point.x, box.y + point.y)
	await page.mouse.down()
	await page.mouse.move(box.x + point.x + 80, box.y + point.y + 60, { steps: 5 })
	await page.mouse.up()
}

// Each session edits once, and every save keeps the restored texts and the edits
const expectRestoredAfterEdits = async (editors: Page[], auth: { fileId: number, jwt: string }, keptTexts = ['Restore kept']) => {
	const stored = async () => {
		const content = await fetchBoardContent(editors[0], auth)
		return {
			texts: visibleTexts(content),
			rectangles: (content?.elements ?? []).filter((element: any) => element.type === 'rectangle' && !element.isDeleted).length,
		}
	}

	for (const [index, editor] of editors.entries()) {
		await drawRectangle(editor, { x: 300 + index * 150, y: 450 })
		await expect.poll(async () => (await stored()).rectangles, { timeout: 30000, intervals: [500] }).toBe(index + 1)
		expect(await stored()).toEqual({ texts: [...keptTexts].sort(), rectangles: index + 1 })
	}

	// Sessions also resend their whole board every 20 seconds
	await editors[0].waitForTimeout(25000)
	expect(await stored()).toEqual({ texts: [...keptTexts].sort(), rectangles: editors.length })
}

test('a restore reaches a session that missed it, also when the server refused its save', async ({
	page,
	browser,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(240000)
	const { auth, storedName, versionEntry } = await prepareRestoreScenario(page, user.userId)
	const otherPage = await openOtherSession(page, browser, storedName)

	await setConnected(otherPage, false)
	let refused = false
	await restoreFromBanner(page, { fileId: auth.fileId, storedName, versionEntry }, async () => {
		// as while the save of another session holds the board
		await page.route(`**/apps/whiteboard/${auth.fileId}`, async (route) => {
			if (route.request().method() !== 'PUT' || refused) {
				await route.fallback()
				return
			}
			refused = true
			await route.fulfill({ status: 409, json: { status: 'conflict' } })
		})
	})
	expect(refused).toBe(true)
	await setConnected(otherPage, true)
	await expect.poll(() => locallyStoredTexts(otherPage, auth.fileId), { timeout: 20000, intervals: [500] }).toEqual(['Restore kept'])

	await expectRestoredAfterEdits([otherPage, page], auth)
	await otherPage.context().close()
})

test('a restored version reaches the other sessions before their next save', async ({
	page,
	browser,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(240000)
	const { auth, storedName, versionEntry } = await prepareRestoreScenario(page, user.userId)
	const otherPage = await openOtherSession(page, browser, storedName)

	await restoreFromBanner(page, { fileId: auth.fileId, storedName, versionEntry })

	await expectRestoredAfterEdits([otherPage, page], auth)
	await otherPage.context().close()
})

test('a version restored from the Files sidebar keeps what others draw meanwhile', async ({
	page,
	browser,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(240000)
	const hasReceived = watchReceivedFrames(page)
	const { auth, storedName, versionEntry } = await prepareRestoreScenario(page, user.userId)
	const otherPage = await openOtherSession(page, browser, storedName)
	const drawn = 'Drawn during the restore'

	const restore = await holdRequests(page, 'MOVE', '**/remote.php/dav/versions/**')
	await requestRestoreFromSidebar(page, auth.fileId, versionEntry)
	await expect.poll(restore.held, { timeout: 20000 }).toBe(1)
	await addTextElement(otherPage, drawn, { x: 900, y: 250 })
	await expect.poll(() => hasReceived(drawn), { timeout: 20000 }).toBe(true)
	// only the restoring session still has the drawing
	await otherPage.context().close()
	restore.release()
	await expect(page.getByText('Version restored').first()).toBeVisible({ timeout: 20000 })
	await expect.poll(async () => visibleTexts(await fetchBoardContent(page, auth)), { timeout: 30000, intervals: [500] })
		.toEqual(['Restore kept', drawn].sort())

	await expectRestoredAfterEdits([page], auth, ['Restore kept', drawn])
})

test('a version that cannot be read is not restored', async ({
	page,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(180000)
	const { auth, versionEntry } = await prepareRestoreScenario(page, user.userId)
	const before = visibleTexts(await fetchBoardContent(page, auth))

	const moves: string[] = []
	page.on('request', (request) => {
		if (request.method() === 'MOVE') {
			moves.push(request.url())
		}
	})
	await page.route(`**${versionEntry.versionSource}`, (route) => route.request().method() === 'GET'
		? route.fulfill({ status: 503 })
		: route.fallback())
	await requestRestoreFromSidebar(page, auth.fileId, versionEntry)
	await expect(page.getByText('Could not restore this version').first()).toBeVisible({ timeout: 20000 })

	expect(moves).toEqual([])
	expect(visibleTexts(await fetchBoardContent(page, auth))).toEqual(before)
})

test('a restore made without a connection reaches the others once the session is back', async ({
	page,
	browser,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(240000)
	const { auth, storedName, versionEntry } = await prepareRestoreScenario(page, user.userId)
	const otherPage = await openOtherSession(page, browser, storedName)

	await setConnected(page, false)
	await requestRestoreFromSidebar(page, auth.fileId, versionEntry)
	await expect(page.getByText('Version restored').first()).toBeVisible({ timeout: 20000 })
	await setConnected(page, true)
	await expect.poll(() => locallyStoredTexts(otherPage, auth.fileId), { timeout: 30000, intervals: [500] }).toEqual(['Restore kept'])

	await expectRestoredAfterEdits([otherPage, page], auth)
	await otherPage.context().close()
})

test('a restored image keeps its file when the restoring session never loaded it', async ({
	page,
	user,
}) => {
	skipWhenVersionContentUnavailable()
	test.setTimeout(240000)
	const boardName = `Version restore image ${Date.now()}`
	await createWhiteboard(page, { name: boardName })
	const authPromise = captureBoardAuthFromSave(page, { containsText: 'Without image' })
	await addTextElement(page, 'Without image')
	const auth = await authPromise
	await waitForBoardContent(page, auth, 'Without image')

	const hasImage = (content: any) => (content?.elements ?? [])
		.some((element: any) => element.type === 'image' && !element.isDeleted && Boolean(content.files?.[element.fileId]))
	await page.getByRole('button', { name: 'Add reaction', exact: true }).click()
	await page.getByRole('region', { name: 'Smileys & Emotion' }).getByLabel('😀, grinning').click()
	await expect.poll(async () => hasImage(await fetchBoardContent(page, auth)), { timeout: 30000, intervals: [500] }).toBe(true)

	const findVersion = (withImage: boolean) => findVersionByContent(page, {
		origin: new URL(page.url()).origin,
		userId: user.userId,
		fileId: auth.fileId,
		includeText: 'Without image',
		accept: (content) => hasImage(content) === withImage,
	})
	// restoring the version without the image drops the image's file from the stored board
	const withoutImage = await findVersion(false)
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)
	await restoreFromBanner(page, { fileId: auth.fileId, storedName, versionEntry: withoutImage })
	await expect.poll(async () => hasImage(await fetchBoardContent(page, auth)), { timeout: 30000, intervals: [500] }).toBe(false)
	await openFilesApp(page)
	await openWhiteboardFromFiles(page, storedName)

	await requestRestoreFromSidebar(page, auth.fileId, await findVersion(true))
	await expect(page.getByText('Version restored').first()).toBeVisible({ timeout: 20000 })
	await drawRectangle(page, { x: 300, y: 450 })
	await expect.poll(async () => (await fetchBoardContent(page, auth)).elements.some((element: any) => element.type === 'rectangle'), { timeout: 30000, intervals: [500] }).toBe(true)
	expect(hasImage(await fetchBoardContent(page, auth))).toBe(true)
})

test('comparing a version shows both boards read-only', async ({
	page,
	user,
}) => {
	test.skip(process.env.SERVER_VERSION !== 'master', 'Comparing versions comes with the viewer of Nextcloud 36')
	test.setTimeout(120000)

	const { versionEntry, storedName } = await prepareVersionScenario(page, user.userId, {
		boardName: `Version compare ${Date.now()}`,
		initialText: 'Compare one',
		updatedText: 'Compare two',
	})
	await page.locator(`[data-cy-files-list-row-name="${storedName}"]`).click({ button: 'right' })
	await page.getByRole('menuitem', { name: /details/i }).first().click()
	await page.getByRole('tab', { name: 'Versions' }).click()
	await page.locator(`.version[data-files-versions-version="${versionEntry.versionId}"]`)
		.getByRole('button', { name: 'Actions' })
		.click()
	await page.locator('[data-cy-files-versions-version-action="compare"]').click()

	const boards = page.locator('whiteboard-viewer')
	await expect(boards).toHaveCount(2, { timeout: 20000 })
	for (const board of await boards.all()) {
		await expect(board.locator('.excalidraw-wrapper .excalidraw canvas').first()).toBeVisible({ timeout: 20000 })
	}
	await expect(page.locator('whiteboard-viewer .excalidraw.excalidraw--view-mode')).toHaveCount(2)
})

test('version preview params still load board content', async ({
	page,
	user,
}) => {
	test.skip(process.env.SERVER_VERSION === 'master', 'Opens a version with the parameters of the legacy viewer; Nextcloud 36 opens version nodes instead')
	test.setTimeout(90000)
	const boardName = `Version preview ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Live content')

	const resolveAuth = async () => {
		try {
			return await getBoardAuth(page)
		} catch {
			const { fileId, jwt } = await captureBoardAuthFromSave(page, {
				containsText: 'Live content',
			})
			return { fileId, jwt }
		}
	}
	const baseAuth = await resolveAuth()
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)

	const versionSource = `/remote.php/dav/files/${user.userId}/${storedName}`
	const params = new URLSearchParams({
		source: versionSource,
		fileVersion: '1.0',
	})
	const origin = new URL(await page.url()).origin
	const previewUrl = `${origin}/index.php/apps/files?${params.toString()}`

	await page.goto(previewUrl)
	const escapedName = storedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const row = page.getByRole('row', { name: new RegExp(escapedName, 'i') })
	await expect(row).toBeVisible({ timeout: 30000 })
	await openWhiteboardInViewer(page, {
		fileId: baseAuth.fileId,
		fileName: storedName,
		source: versionSource,
		fileVersion: '1.0',
	})
	await waitForCanvas(page)

	const tokenResponse = await page.request.get(
		`apps/whiteboard/${baseAuth.fileId}/token`,
	)
	expect(tokenResponse.ok()).toBeTruthy()
	const token = (await tokenResponse.json()).token

	const previewAuth = { fileId: baseAuth.fileId, jwt: token }
	const payload = JSON.parse(
		Buffer.from(token.split('.')[1], 'base64').toString(),
	)
	expect(payload?.isFileReadOnly).toBeFalsy()

	await expect
		.poll(
			async () =>
				JSON.stringify(await fetchBoardContent(page, previewAuth)),
			{
				timeout: 20000,
				intervals: [500],
			},
		)
		.toContain('Live content')
})
