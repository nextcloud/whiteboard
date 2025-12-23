/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	createWhiteboard,
	getCanvasForInteraction,
	openFilesApp,
	waitForCanvas,
} from '../support/utils'

async function createPublicShareLink(page: Page, baseName: string): Promise<string> {
	const requestToken = await page.evaluate(() => (window as any).OC?.requestToken ?? null)

	const candidates = (() => {
		const lower = baseName.toLowerCase()
		if (lower.endsWith('.whiteboard') || lower.endsWith('.excalidraw')) {
			return [baseName]
		}
		return [`${baseName}.whiteboard`, `${baseName}.excalidraw`, baseName]
	})()

	for (const candidate of candidates) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await page.evaluate(async ({ candidate, requestToken }) => {
				const body = new URLSearchParams({
					path: `/${candidate}`,
					shareType: '3',
					permissions: '1',
				})

				const response = await fetch('ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', {
					method: 'POST',
					credentials: 'include',
					headers: {
						'OCS-APIREQUEST': 'true',
						...(requestToken ? { requesttoken: requestToken } : {}),
						'Content-Type': 'application/x-www-form-urlencoded',
						Accept: 'application/json',
					},
					body,
				})

				const text = await response.text()
				let data = null
				try {
					data = JSON.parse(text)
				} catch {
					// ignore non JSON
				}

				return {
					status: response.status,
					data,
				}
			}, { candidate, requestToken })

			const metaStatus = result?.data?.ocs?.meta?.statuscode
			const shareUrl = result?.data?.ocs?.data?.url
			if (metaStatus === 200 && typeof shareUrl === 'string') {
				return shareUrl
			}

			await page.waitForTimeout(1000)
		}
	}

	// Fallback: use the UI share sidebar to create a link
	const row = page.getByRole('row', { name: new RegExp(baseName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')) })
	const shareButton = row.getByRole('button', { name: /Sharing options|Actions/i }).first()
	await shareButton.click()

	const createLinkButton = page.getByRole('button', { name: /create a new share link/i }).first()
	await expect(createLinkButton).toBeVisible({ timeout: 15000 })
	await createLinkButton.click()

	const copyButton = page.getByRole('button', { name: /copy public link/i }).first()
	await expect(copyButton).toBeVisible({ timeout: 15000 })
	const dataClipboard = await copyButton.getAttribute('data-clipboard-text')
	if (dataClipboard) {
		return dataClipboard
	}

	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
	await copyButton.click()
	const clipboardText = await page.evaluate(async () => {
		try {
			return await navigator.clipboard.readText()
		} catch {
			return ''
		}
	})

	if (!clipboardText) {
		throw new Error(`Failed to create public share link for ${baseName}`)
	}
	return clipboardText
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('public share loads viewer in read only mode', async ({ page, browser }) => {
	test.setTimeout(120000)
	const boardName = `Shared board ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Shared marker')
	await waitForCanvas(page)

	// Wait until the file appears in the Files list to ensure backend persistence
	await openFilesApp(page)
	const fileRow = page.getByRole('row', { name: new RegExp(boardName) })
	await expect(fileRow).toBeVisible({ timeout: 30000 })

	const storedName = (await fileRow.evaluate<string | null>((row) => {
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
		const textMatch = text.match(/([\\w\\s.-]+\\.whiteboard|[\\w\\s.-]+\\.excalidraw)/i)
		if (textMatch?.[1]) {
			return textMatch[1]
		}
		return null
	})) ?? `${boardName}.whiteboard`

	const shareUrl = await createPublicShareLink(page, storedName)

	// Open the share link in a clean context to mimic an external visitor
	const shareContext = await browser.newContext({ storageState: undefined })
	const response = await shareContext.request.get(shareUrl)
	expect(response.ok()).toBeTruthy()

	const body = await response.text()
	expect(body.toLowerCase()).toContain('whiteboard')

	// If a JWT is present, ensure it marks the file as read only
	const jwtMatch = body.match(/"jwt"\s*:\s*"([^"]+)"/)
	const embeddedJwt = jwtMatch ? jwtMatch[1] : null
	if (jwtMatch) {
		const token = jwtMatch[1]
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
		expect(payload?.isFileReadOnly).not.toBe(false)
	}

	const sharePage = await shareContext.newPage()
	await sharePage.goto(shareUrl)
	await waitForCanvas(sharePage)

	const { fileId, jwt } = await sharePage.evaluate(() => {
		try {
			const load = (window as any).OCP?.InitialState?.loadState
			return {
				fileId: load ? Number(load('whiteboard', 'file_id')) : null,
				jwt: load ? String(load('whiteboard', 'jwt') || '') : null,
			}
		} catch {
			return { fileId: null, jwt: null }
		}
	})

	const effectiveJwt = jwt || embeddedJwt

	const attemptEdit = async () => {
		const canvas = await getCanvasForInteraction(sharePage)
		await canvas.click({ position: { x: 140, y: 140 } })
		await sharePage.keyboard.type('Read only attempt')
		await sharePage.waitForTimeout(1500)
		if (!fileId || !effectiveJwt) {
			return null
		}
		const response = await sharePage.request.get(`apps/whiteboard/${fileId}`, {
			headers: { Authorization: `Bearer ${effectiveJwt}` },
		})
		expect(response.ok()).toBeTruthy()
		const shareBody = await response.json()
		return JSON.stringify(shareBody.data)
	}

	const before = await attemptEdit()
	const after = await attemptEdit()
	if (before && after) {
		expect(after).toBe(before)
	}

	await shareContext.close()
})
