/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { openFilesApp } from '../support/utils'

async function resolveUserId(page: Page) {
	const origin = new URL(await page.url()).origin
	const response = await page.request.get(`${origin}/ocs/v2.php/cloud/user?format=json`, {
		headers: { 'OCS-APIREQUEST': 'true' },
	})
	if (!response.ok()) {
		throw new Error(`Failed to resolve user id: ${response.status()}`)
	}
	const payload = await response.json().catch(() => null)
	const userId = payload?.ocs?.data?.id
	if (!userId) {
		throw new Error('User id missing from OCS response')
	}
	return userId
}

const fileIdPropfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
	<d:prop>
		<oc:fileid />
	</d:prop>
</d:propfind>`

async function createWhiteboardFile(page: Page, name: string) {
	const origin = new URL(await page.url()).origin
	const requestToken = await page.evaluate(() => (window as any).OC?.requestToken
		|| (document.querySelector('head meta[name="requesttoken"]') as HTMLMetaElement | null)?.content
		|| null)
	const userId = await resolveUserId(page)
	const filePath = encodeURIComponent(name)
	const content = JSON.stringify({ elements: [], files: {}, scrollToContent: true })

	const putResponse = await page.request.fetch(`${origin}/remote.php/dav/files/${userId}/${filePath}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			...(requestToken ? { requesttoken: requestToken } : {}),
			'X-Requested-With': 'XMLHttpRequest',
		},
		data: content,
	})
	if (!putResponse.ok()) {
		throw new Error(`Failed to create whiteboard file: ${putResponse.status()}`)
	}

	const propfind = await page.request.fetch(`${origin}/remote.php/dav/files/${userId}/${filePath}`, {
		method: 'PROPFIND',
		headers: {
			Depth: '0',
			Accept: 'application/xml',
			'Content-Type': 'application/xml',
			...(requestToken ? { requesttoken: requestToken } : {}),
			'X-Requested-With': 'XMLHttpRequest',
		},
		data: fileIdPropfindBody,
	})
	if (!propfind.ok()) {
		throw new Error(`Failed to resolve fileId: ${propfind.status()}`)
	}
	const xml = await propfind.text()
	const match = xml.match(/<(?:oc:)?fileid>([^<]+)<\/(?:oc:)?fileid>/)
	if (!match?.[1]) {
		throw new Error('fileId missing in PROPFIND response')
	}
	return { fileId: Number(match[1]), userId }
}

async function fetchJwt(page: Page, fileId: number) {
	const response = await page.request.get(`apps/whiteboard/${fileId}/token`)
	if (!response.ok()) {
		throw new Error(`Failed to fetch JWT: ${response.status()}`)
	}
	const payload = await response.json().catch(() => null)
	const token = payload?.token
	if (!token) {
		throw new Error('JWT missing from response')
	}
	return token as string
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('recording response disables caching', async ({ page }) => {
	const boardName = `Recording cache ${Date.now()}.whiteboard`
	const { fileId, userId } = await createWhiteboardFile(page, boardName)
	const jwt = await fetchJwt(page, fileId)

	const origin = new URL(await page.url()).origin
	const recordingUrl = `${origin}/index.php/apps/whiteboard/recording/${fileId}/${userId}?token=${encodeURIComponent(jwt)}`

	const response = await page.request.get(recordingUrl)
	expect(response.ok()).toBeTruthy()

	const headers = response.headers()
	const cacheControl = headers['cache-control'] || ''
	const pragma = headers['pragma'] || ''

	expect(cacheControl).toMatch(/no-cache|no-store|max-age=0/i)
	if (cacheControl.includes('no-cache') || cacheControl.includes('no-store')) {
		expect(true).toBeTruthy()
	} else {
		expect(pragma).toMatch(/no-cache/i)
	}
})
