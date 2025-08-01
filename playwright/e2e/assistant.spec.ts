/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { test } from '../support/fixtures/random-user'
import { expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
	await page.route(
		'**/ocs/v2.php/taskprocessing/task/*',
		(route, request) => {
			const taskId = parseInt(request.url().split('/').pop() || '0', 10) // Extract taskId from URL
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ocs: {
						meta: {
							status: 'ok',
							statuscode: 200,
							message: 'OK',
						},
						data: {
							task: {
								id: taskId,
								type: 'core:text2text',
								lastUpdated: 1744024462,
								status: 'STATUS_SUCCESSFUL',
								userId: 'admin',
								appId: 'whiteboard',
								input: {
									max_tokens: 1234,
									model: 'model_2',
									input: 'a',
								},
								output: {
									output: `flowchart TD
 A[Christmas] -->|Get money| B(Go shopping)
 B --> C{Let me think}
 C -->|One| D[Laptop]
 C -->|Two| E[iPhone]
 C -->|Three| F[Car]`,
								},
								customId: '',
								completionExpectedAt: 1744024460,
								progress: 1,
								scheduledAt: 1744024459,
								startedAt: 1744024462,
								endedAt: 1744024462,
							},
						},
					},
				}),
			})
		},
	)

	await page.goto('apps/files')
	await page.waitForURL(/apps\/files/)
})

test('Assistant Button', async ({ page }) => {
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()
	await page.getByRole('button', { name: 'Assistant', exact: true }).click()
	await page.getByRole('textbox', { name: 'Prompt to generate diagram' }).fill('abc')
	await page.getByRole('button', { name: 'Generate' }).click()
	await expect(page.getByRole('textbox', { name: 'Prompt to generate diagram' })).not.toBeVisible()
})

test('Restart on false Assistant output', async ({ page }) => {
	await page.route(
		'**/ocs/v2.php/taskprocessing/task/*',
		(route, request) => {
			const taskId = parseInt(request.url().split('/').pop() || '0', 10) // Extract taskId from URL
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ocs: {
						meta: {
							status: 'ok',
							statuscode: 200,
							message: 'OK',
						},
						data: {
							task: {
								id: taskId,
								type: 'core:text2text',
								lastUpdated: 1744024462,
								status: 'STATUS_SUCCESSFUL',
								userId: 'admin',
								appId: 'whiteboard',
								input: {
									max_tokens: 1234,
									model: 'model_2',
									input: 'a',
								},
								output: {
									output: 'INVALID MERMAID SYNTAX',
								},
								customId: '',
								completionExpectedAt: 1744024460,
								progress: 1,
								scheduledAt: 1744024459,
								startedAt: 1744024462,
								endedAt: 1744024462,
							},
						},
					},
				}),
			})
		},
	)
	await page.getByRole('button', { name: 'New' }).click()
	await page.getByRole('menuitem', { name: 'New whiteboard' }).click()
	await page.getByRole('button', { name: 'Create' }).click()
	await expect(page.getByText('Drawing canvas')).toBeVisible()
	await page.getByRole('button', { name: 'Assistant', exact: true }).click()
	await page.getByRole('textbox', { name: 'Prompt to generate diagram' }).fill('abc')
	await page.getByRole('button', { name: 'Generate' }).click()
	await expect(page.getByRole('textbox', { name: 'Prompt to generate diagram' })).toHaveValue('abc')
})
