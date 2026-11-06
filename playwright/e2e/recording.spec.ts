/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { WebSocketRoute } from '@playwright/test'

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, dismissRecordingNotice, openFilesApp } from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('recording unavailable notice is dismissible and main menu remains usable', async ({ page }) => {
	await createWhiteboard(page, { name: `Recording check ${Date.now()}` })

	const notice = page.locator('.recording-unavailable')
	if (await notice.count()) {
		await expect(notice).toBeVisible({ timeout: 20000 })
		await expect(notice.getByText('Recording unavailable')).toBeVisible()
	}

	await dismissRecordingNotice(page)
	await expect(notice).toBeHidden({ timeout: 5000 })

	await page.getByTestId('main-menu-trigger').click()
	const recordingButton = page.locator('.recording-button')
	const presentationButton = page.locator('.presentation-button')
	// The item appears once the collaboration server answered the availability check
	await expect(recordingButton).toBeVisible({ timeout: 20000 })
	await expect(presentationButton).toBeVisible()
})

test('recording turned off on the collaboration server hides the recording item', async ({ page }) => {
	let connection: WebSocketRoute | undefined
	await page.routeWebSocket(/socket\.io/, (route) => {
		connection = route
		const server = route.connectToServer()
		server.onMessage((message) => {
			route.send(typeof message === 'string' && message.startsWith('42["recording-availability"')
				? '42["recording-availability",{"available":true,"reason":null}]'
				: message)
		})
	})
	await page.addInitScript(() => {
		new MutationObserver(() => {
			if (document.querySelector('.recording-unavailable')) {
				sessionStorage.setItem('recordingNoticeShown', 'true')
			}
		}).observe(document, { childList: true, subtree: true })
	})
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Recording off ${Date.now()}` })

	await page.getByTestId('main-menu-trigger').click()
	await expect(page.locator('.recording-button')).toBeVisible({ timeout: 20000 })

	connection!.send('42["recording-availability",{"available":false,"enabled":false,"reason":null}]')
	await expect(page.locator('.recording-button')).toHaveCount(0)
	await expect(page.locator('.presentation-button')).toBeVisible()
	expect(await page.evaluate(() => sessionStorage.getItem('recordingNoticeShown'))).toBeNull()
})
