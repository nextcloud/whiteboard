/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	createWhiteboard,
	openFilesApp,
	waitForCanvas,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		;(window as any).__whiteboardTest = true
		;(window as any).__whiteboardTestHooks = {
			blockInitialData: true,
		}
	})
	await openFilesApp(page)
})

test('resolves stale initial data promises', async ({ page }) => {
	test.setTimeout(90000)
	await createWhiteboard(page)
	await waitForCanvas(page)

	await expect.poll(
		async () => page.evaluate(() => Boolean((window as any).__whiteboardTestHooks?.pendingInitialData)),
		{
			timeout: 10000,
			interval: 200,
		},
	).toBeTruthy()

	const loadingScene = page.getByText(/Loading scene/i)
	await expect(loadingScene).toBeVisible({ timeout: 5000 })

	await page.evaluate(() => {
		const hooks = (window as any).__whiteboardTestHooks
		if (!hooks?.whiteboardConfigStore) {
			throw new Error('Whiteboard test hooks not available')
		}
		const store = hooks.whiteboardConfigStore
		const pending = hooks.pendingInitialData
		store.getState().resetInitialDataPromise()
		hooks.restoreResolveInitialData?.()
		store.getState().resolveInitialData(pending)
	})

	await expect(loadingScene).toBeHidden({ timeout: 5000 })
})
