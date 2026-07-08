/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test as base, type Page } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, openFilesApp, waitForCanvas } from '../support/utils'

const trackConsoleErrors = (page: Page) => {
	const consoleErrors: string[] = []
	page.on('console', (message) => {
		if (message.type() === 'error') {
			const text = message.text()
			if (
				!text.includes('violates the following Content Security Policy directive')
				&& !text.includes('Refused to connect because it violates the document\'s Content Security Policy')
				&& !text.includes('the server responded with a status of 500 (Internal Server Error)')
				&& !text.includes('the server responded with a status of 404 (Not Found)')
				&& !text.includes('Failed to load user status')
				&& !text.includes('[ERROR] viewer: Could not register handler')
			) {
				consoleErrors.push(text)
			}
		}
	})
	page.on('pageerror', (error) => {
		consoleErrors.push(error.message)
	})
	return consoleErrors
}

const loginAsAdmin = async (page: Page) => {
	const tokenResponse = await page.request.get('./csrftoken', { failOnStatusCode: true })
	const requesttoken = (await tokenResponse.json()).token
	const loginResponse = await page.request.post('./login', {
		form: {
			user: 'admin',
			password: 'admin',
			requesttoken,
		},
		headers: {
			Origin: tokenResponse.url().replace(/index.php.*/, ''),
		},
		maxRedirects: 0,
	})
	const location = loginResponse.headers().location ?? ''
	expect(loginResponse.status()).toBe(303)
	expect(location).not.toMatch(/\/login(\?|$)/)
}

test('Vue 3 personal settings save and failure', async ({ page }) => {
	const consoleErrors = trackConsoleErrors(page)

	await page.goto('settings/user/whiteboard')
	await expect(page.getByText('Save recordings automatically when I leave a board')).toBeVisible()

	const switchInput = page.locator('input[type="checkbox"]').first()
	await expect(switchInput).toBeAttached()
	const successResponse = page.waitForResponse(response =>
		response.url().includes('/apps/whiteboard/settings/personal') && response.request().method() === 'POST')
	await switchInput.click({ force: true })
	await expect((await successResponse).ok()).toBe(true)

	await page.route('**/apps/whiteboard/settings/personal', route => route.fulfill({
		status: 500,
		contentType: 'application/json',
		body: JSON.stringify({ error: 'forced failure' }),
	}), { times: 1 })
	await switchInput.click({ force: true })
	await expect(page.getByText('Failed to save recording preference.')).toBeVisible()

	expect(consoleErrors).toEqual([])
})

test('Vue 3 table editor dialog cycles with Text app', async ({ page }) => {
	test.setTimeout(120000)
	const consoleErrors = trackConsoleErrors(page)

	await openFilesApp(page)
	await createWhiteboard(page, { name: `Vue3 table cycles ${Date.now()}` })
	await waitForCanvas(page)

	const tableButton = page.getByRole('button', { name: 'Insert table' })
	await expect(tableButton).toBeVisible({ timeout: 20000 })
	for (let i = 0; i < 5; i++) {
		await tableButton.click()
		const dialog = page.locator('.table-editor-dialog').filter({ hasText: 'Insert Table' })
		await expect(dialog).toBeVisible()
		await expect(dialog.getByText('Loading editor…')).toBeHidden({ timeout: 10000 })
		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await expect(dialog).toBeHidden()
	}

	expect(consoleErrors).toEqual([])
})

base('Vue 3 admin settings render and validation', async ({ browser, baseURL }) => {
	const page = await browser.newPage({
		baseURL,
		storageState: undefined,
	})
	const consoleErrors = trackConsoleErrors(page)

	await loginAsAdmin(page)
	await page.goto('settings/admin/whiteboard')
	await expect(page.getByText('Real-time collaboration server')).toBeVisible()
	await expect(page.getByLabel('WebSocket server URL')).toBeVisible()
	await expect(page.getByLabel('Shared secret')).toBeVisible()

	await page.getByLabel('Max image size (MB)').fill('0')
	await page.getByLabel('Max image size (MB)').blur()
	await expect(page.getByText('Max image size must be a positive number.')).toBeVisible()

	expect(consoleErrors).toEqual([])
	await page.close()
})
