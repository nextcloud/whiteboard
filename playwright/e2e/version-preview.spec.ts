/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, type Page } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createWhiteboard,
	fetchBoardContent,
	openFilesApp,
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
	},
): Promise<{ versionId: string, versionSource: string }> => {
	const { origin, userId, fileId, includeText, excludeText } = options
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
			return { versionId, versionSource }
		}

		await page.waitForTimeout(1000)
	}

	throw new Error(`No matching version found for ${includeText}`)
}

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
	options: { fileName: string, fileVersion: string },
) => {
	await page.locator(`[data-cy-files-list-row-name="${options.fileName}"]`).click({ button: 'right' })
	await page.getByRole('menuitem', { name: /details/i }).first().click()
	await page.getByRole('tab', { name: 'Versions' }).click()
	await page.locator(`.version[data-files-versions-version="${options.fileVersion}"] a`).click()
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
		fileName: storedName,
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
		fileName: storedName,
		fileVersion: versionEntry.versionId,
	})
	await waitForCanvas(page)

	const restoreButton = page.getByRole('button', { name: 'Restore this version' })
	await expect(restoreButton).toBeVisible()
	await restoreButton.click()

	const banner = page.locator('.version-preview-banner')
	await expect(banner).toBeHidden({ timeout: 20000 })

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, baseAuth)), {
		timeout: 30000,
		intervals: [500],
	}).toContain(initialText)
	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, baseAuth)), {
		timeout: 30000,
		intervals: [500],
	}).not.toContain(updatedText)
})
