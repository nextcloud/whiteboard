/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Buffer } from 'buffer'
import { expect } from '@playwright/test'
import { createRandomUser } from '@nextcloud/e2e-test-server/playwright'
import { test } from '../support/fixtures/random-user'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createUserShare,
	createWhiteboard,
	fetchBoardContent,
	getBoardAuth,
	openFilesApp,
	openWhiteboardFromFiles,
	resolveStoredFileName,
} from '../support/utils'

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('user shares honor read-only and edit permissions', async ({ page, browser }) => {
	test.setTimeout(150000)
	const boardName = `Shared permissions ${Date.now()}`

	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'Owner content')
	const resolveAuth = async (targetPage: any, options: { containsText?: string, allowCapture?: boolean } = {}) => {
		try {
			return await getBoardAuth(targetPage)
		} catch {
			if (options.allowCapture === false) {
				throw new Error('Whiteboard auth not available from initial state')
			}
			const { fileId, jwt } = await captureBoardAuthFromSave(targetPage, { containsText: options.containsText })
			return { fileId, jwt }
		}
	}
	const auth = await resolveAuth(page, { containsText: 'Owner content' })
	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 20000,
		interval: 500,
	}).toContain('Owner content')
	await openFilesApp(page)
	const storedName = await resolveStoredFileName(page, boardName)

	const readonlyUser = await createRandomUser()
	const editorUser = await createRandomUser()

	await createUserShare(page, { fileName: storedName, shareWith: readonlyUser.userId, permissions: 1 })
	await createUserShare(page, { fileName: storedName, shareWith: editorUser.userId, permissions: 15 })

	const baseOrigin = new URL(await page.url()).origin

	const getShareEntry = async (userId: string) => {
		let lastMeta: any = null
		const headers = { 'OCS-APIREQUEST': 'true', Accept: 'application/json' }

		for (let attempt = 0; attempt < 10; attempt++) {
			const response = await page.request.get(
				`${baseOrigin}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`,
				{ headers },
			)
			const payload = await response.json().catch(async () => {
				return { raw: await response.text() }
			})
			lastMeta = payload?.ocs?.meta || payload
			const shares = Array.isArray(payload?.ocs?.data) ? payload.ocs.data : []
			const match = shares.find((entry: any) =>
				entry?.share_with === userId
				&& typeof entry?.file_target === 'string'
				&& entry.file_target.includes(storedName),
			)
			if (match) {
				return match
			}
			await page.waitForTimeout(400)
		}

		throw new Error(`Could not locate share entry for ${userId} (${JSON.stringify(lastMeta)})`)
	}

	const shareEntries = [
		{ user: readonlyUser, entry: await getShareEntry(readonlyUser.userId) },
		{ user: editorUser, entry: await getShareEntry(editorUser.userId) },
	]

	const withEditAccess = shareEntries.filter((item) => (Number(item.entry.permissions) & 2) !== 0)
	const readOnlyEntry = shareEntries.find((item) => (Number(item.entry.permissions) & 2) === 0)
	const editableEntry = withEditAccess.find((item) => item.user.userId !== readOnlyEntry?.user.userId)

	if (!readOnlyEntry || !editableEntry) {
		throw new Error(`Share permissions did not yield distinct read-only and edit users (${JSON.stringify(shareEntries)})`)
	}

	const openAsUser = async (user: any, expectedReadOnly: boolean) => {
		const context = await browser.newContext({
			baseURL: `${baseOrigin}/index.php/`,
			storageState: undefined,
		})
		const userPage = await context.newPage()
		await userPage.goto('login')
		await userPage.locator('input[name="user"], input[id="user"]').first().fill(user.userId)
		await userPage.locator('input[name="password"], input[id="password"]').first().fill(user.password)
		const submitButton = userPage.locator('button[type="submit"][data-login-form-submit]').first()
		if (await submitButton.count()) {
			await submitButton.click()
		} else {
			await userPage.getByRole('button', { name: /^log in$/i }).first().click()
		}
		await userPage.waitForLoadState('networkidle')
		const userInfoResponse = await userPage.request.get(`${baseOrigin}/ocs/v2.php/cloud/user?format=json`, {
			headers: { 'OCS-APIREQUEST': 'true' },
		})
		const userInfo = await userInfoResponse.json().catch(async () => {
			return { raw: await userInfoResponse.text() }
		})
		if (userInfo?.ocs?.data?.id !== user.userId) {
			throw new Error(`Failed to log in as ${user.userId}: ${userInfoResponse.status()} ${JSON.stringify(userInfo)}`)
		}

		await openWhiteboardFromFiles(userPage, storedName, { preferSharedView: true })

		let userAuth: { fileId: number, jwt: string }
		try {
			userAuth = await resolveAuth(userPage, { allowCapture: false })
		} catch {
			const storedAuthHandle = await userPage.waitForFunction(() => {
				try {
					const raw = window.localStorage.getItem('jwt-storage')
					if (!raw) {
						return null
					}
					const parsed = JSON.parse(raw)
					const tokens = parsed?.state?.tokens || parsed?.tokens || {}
					const entries = Object.entries(tokens)
					if (!entries.length) {
						return null
					}
					const [fileId, jwt] = entries[0]
					if (!jwt || !fileId) {
						return null
					}
					return { fileId: Number(fileId), jwt: String(jwt) }
				} catch {
					return null
				}
			}, { timeout: 20000 })
			const storedAuth = storedAuthHandle ? await storedAuthHandle.jsonValue() as any : null
			if (!storedAuth?.fileId || !storedAuth?.jwt) {
				throw new Error(`Whiteboard auth not available from initial state or token store for ${user.userId}`)
			}
			userAuth = storedAuth
		}
		const payload = JSON.parse(Buffer.from(userAuth.jwt.split('.')[1], 'base64').toString())
		if (!expectedReadOnly && payload?.isFileReadOnly !== undefined) {
			expect(Boolean(payload.isFileReadOnly)).toBe(false)
		}

		const beforeData = await fetchBoardContent(userPage, userAuth)
		const tokenHeader = userAuth.jwt.startsWith('Bearer ') ? userAuth.jwt : `Bearer ${userAuth.jwt}`

		if (expectedReadOnly) {
			const attemptElement = {
				id: `readonly-attempt-${Date.now()}`,
				type: 'text',
				text: 'Read-only attempt',
				x: 20,
				y: 20,
				width: 100,
				height: 40,
				baseline: 32,
				fontSize: 20,
				fontFamily: 1,
				angle: 0,
				roughness: 0,
				strokeWidth: 1,
				opacity: 100,
				groupIds: [],
				seed: Math.floor(Math.random() * 100000),
				version: 1,
				versionNonce: Math.floor(Math.random() * 1000000),
				isDeleted: false,
				boundElementIds: [],
				updated: Date.now(),
			}
			const attemptedUpdate = {
				...beforeData,
				elements: [ ...(beforeData as any).elements || [], attemptElement ],
			}
			const putResponse = await userPage.request.put(`apps/whiteboard/${userAuth.fileId}`, {
				headers: {
					Authorization: tokenHeader,
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
				},
				data: { data: attemptedUpdate },
			})
			expect(putResponse.ok()).toBeFalsy()
			const after = JSON.stringify(await fetchBoardContent(userPage, userAuth))
			expect(after).not.toContain('Read-only attempt')
			expect(after).toBe(JSON.stringify(beforeData))
		} else {
			const baseElement = Array.isArray((beforeData as any).elements) && (beforeData as any).elements.length > 0
				? (beforeData as any).elements[0]
				: null
			const newElement = {
				id: `share-edit-${Date.now()}`,
				type: baseElement?.type || 'text',
				text: 'Editor update',
				x: (baseElement?.x || 0) + 40,
				y: (baseElement?.y || 0) + 40,
				width: baseElement?.width || 100,
				height: baseElement?.height || 40,
				baseline: baseElement?.baseline || 32,
				fontSize: baseElement?.fontSize || 20,
				fontFamily: baseElement?.fontFamily || 1,
				angle: baseElement?.angle || 0,
				roundness: baseElement?.roundness,
				strokeColor: baseElement?.strokeColor || '#1e1e1e',
				backgroundColor: baseElement?.backgroundColor || 'transparent',
				fillStyle: baseElement?.fillStyle || 'hachure',
				strokeWidth: baseElement?.strokeWidth || 1,
				roughness: baseElement?.roughness || 0,
				opacity: baseElement?.opacity || 100,
				groupIds: baseElement?.groupIds || [],
				seed: Math.floor(Math.random() * 100000),
				version: 1,
				versionNonce: Math.floor(Math.random() * 1000000),
				isDeleted: false,
				boundElementIds: [],
				updated: Date.now(),
			}
			const updated = {
				...beforeData,
				elements: [ ...(beforeData as any).elements || [], newElement ],
			}
			const putResponse = await userPage.request.put(`apps/whiteboard/${userAuth.fileId}`, {
				headers: {
					Authorization: tokenHeader,
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
				},
				data: { data: updated },
			})
			expect(putResponse.ok()).toBeTruthy()
			await expect.poll(async () => JSON.stringify(await fetchBoardContent(userPage, userAuth)), {
				timeout: 20000,
				interval: 500,
			}).toContain('Editor update')
		}

		await context.close()
	}

	await openAsUser(readOnlyEntry.user, true)
	await openAsUser(editableEntry.user, false)

	await expect.poll(async () => JSON.stringify(await fetchBoardContent(page, auth)), {
		timeout: 20000,
		interval: 500,
	}).toContain('Editor update')
})
