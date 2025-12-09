/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Buffer } from 'buffer'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createWhiteboard,
	fetchBoardContent,
	getBoardAuth,
	openFilesApp,
	resolveStoredFileName,
	waitForCanvas,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('version preview params still load board content', async ({ page, user }) => {
	test.setTimeout(90000)
	const boardName = `Version preview ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Live content')

	const resolveAuth = async () => {
		try {
			return await getBoardAuth(page)
		} catch {
			const { fileId, jwt } = await captureBoardAuthFromSave(page, { containsText: 'Live content' })
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
	await row.click()
	await waitForCanvas(page)

	const tokenResponse = await page.request.get(`apps/whiteboard/${baseAuth.fileId}/token`)
	expect(tokenResponse.ok()).toBeTruthy()
	const token = (await tokenResponse.json()).token

	const previewAuth = { fileId: baseAuth.fileId, jwt: token }
	const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
	expect(payload?.isFileReadOnly).toBeFalsy()

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, previewAuth)), {
		timeout: 20000,
		interval: 500,
	}).toContain('Live content')
})
