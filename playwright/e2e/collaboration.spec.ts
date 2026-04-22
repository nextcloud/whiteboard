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
	newLoggedInPage,
	openWhiteboardById,
	openFilesApp,
	resolveFileIdByDav,
} from '../support/utils'

type CapturedSceneMessage = {
	transport: 'room' | 'direct'
	type: string
	syncAll: boolean
	elementsCount: number
}

type ReceivedSceneMessage = {
	type: string
	syncAll: boolean
	elementsCount: number
}

type CollaborationSocketHook = {
	connected?: boolean
	emit: (eventName: string, ...args: unknown[]) => unknown
}

type WhiteboardTestHooks = {
	collaborationStore?: {
		getState?: () => {
			socket?: CollaborationSocketHook
			isInRoom?: boolean
		}
	}
	excalidrawStore?: {
		getState?: () => {
			excalidrawAPI?: {
				getSceneElementsIncludingDeleted?: () => Array<{
					type?: string
					text?: string
					isDeleted?: boolean
				}>
			}
		}
	}
	emittedSceneMessages?: CapturedSceneMessage[]
	receivedSceneMessages?: ReceivedSceneMessage[]
	sceneEmitSpyInstalled?: boolean
	sceneReceiveSpyInstalled?: boolean
}

type WhiteboardTestWindow = Window & {
	__whiteboardTest?: boolean
	__whiteboardTestHooks?: WhiteboardTestHooks
}

async function enableWhiteboardTestHooks(page: Page) {
	await page.addInitScript(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTest = true
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		win.__whiteboardTestHooks.emittedSceneMessages = []
		win.__whiteboardTestHooks.receivedSceneMessages = []
	})
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTest = true
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		win.__whiteboardTestHooks.emittedSceneMessages = win.__whiteboardTestHooks.emittedSceneMessages || []
		win.__whiteboardTestHooks.receivedSceneMessages = win.__whiteboardTestHooks.receivedSceneMessages || []
	})
}

async function waitForCollaborationReady(page: Page) {
	await page.waitForFunction(() => {
		const win = window as WhiteboardTestWindow
		const store = win.__whiteboardTestHooks?.collaborationStore
		const state = store?.getState?.()
		return Boolean(state?.socket?.connected && state?.isInRoom)
	}, { timeout: 30000 })
}

async function installSceneEmitSpy(page: Page) {
	await waitForCollaborationReady(page)
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		const hooks = win.__whiteboardTestHooks
		hooks.emittedSceneMessages = hooks.emittedSceneMessages || []
		if (hooks.sceneEmitSpyInstalled) {
			return
		}

		const store = hooks.collaborationStore
		const socket = store?.getState?.().socket
		if (!socket) {
			throw new Error('Collaboration socket not available')
		}

		const decodePayload = (payload: unknown) => {
			if (typeof payload === 'string') {
				return payload
			}
			if (payload instanceof ArrayBuffer) {
				return new TextDecoder().decode(new Uint8Array(payload))
			}
			if (ArrayBuffer.isView(payload)) {
				return new TextDecoder().decode(
					new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
				)
			}
			return ''
		}

		const originalEmit = socket.emit.bind(socket)
		socket.emit = (eventName: string, ...args: unknown[]) => {
			if (eventName === 'server-broadcast' || eventName === 'server-direct-broadcast') {
				const decoded = decodePayload(eventName === 'server-direct-broadcast' ? args[2] : args[1])
				if (decoded) {
					try {
						const parsed = JSON.parse(decoded)
						if (parsed?.type === 'SCENE_INIT' || parsed?.type === 'SCENE_UPDATE') {
							hooks.emittedSceneMessages?.push({
								transport: eventName === 'server-direct-broadcast' ? 'direct' : 'room',
								type: parsed.type,
								syncAll: parsed.payload?.syncAll === true,
								elementsCount: Array.isArray(parsed.payload?.elements)
									? parsed.payload.elements.length
									: 0,
							})
						}
					} catch {
						// Ignore frames that are not JSON scene payloads.
					}
				}
			}
			return originalEmit(eventName, ...args)
		}

		hooks.sceneEmitSpyInstalled = true
	})
}

async function clearCapturedSceneMessages(page: Page) {
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.emittedSceneMessages
		if (messages) {
			messages.length = 0
		} else if (win.__whiteboardTestHooks) {
			win.__whiteboardTestHooks.emittedSceneMessages = []
		}
	})
}

async function getCapturedSceneMessages(page: Page): Promise<CapturedSceneMessage[]> {
	return page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		return win.__whiteboardTestHooks?.emittedSceneMessages || []
	})
}

async function installSceneReceiveSpy(page: Page) {
	await waitForCollaborationReady(page)
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		const hooks = win.__whiteboardTestHooks
		hooks.receivedSceneMessages = hooks.receivedSceneMessages || []
		if (hooks.sceneReceiveSpyInstalled) {
			return
		}

		const store = hooks.collaborationStore
		const socket = store?.getState?.().socket
		if (!socket) {
			throw new Error('Collaboration socket not available')
		}

		const decodePayload = (payload: unknown) => {
			if (typeof payload === 'string') {
				return payload
			}
			if (payload instanceof ArrayBuffer) {
				return new TextDecoder().decode(new Uint8Array(payload))
			}
			if (ArrayBuffer.isView(payload)) {
				return new TextDecoder().decode(
					new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
				)
			}
			return ''
		}

		socket.onAny((eventName: string, ...args: unknown[]) => {
			if (eventName !== 'client-broadcast') {
				return
			}

			const decoded = decodePayload(args[0])
			if (!decoded) {
				return
			}

			try {
				const parsed = JSON.parse(decoded)
				if (parsed?.type === 'SCENE_INIT' || parsed?.type === 'SCENE_UPDATE') {
					hooks.receivedSceneMessages?.push({
						type: parsed.type,
						syncAll: parsed.payload?.syncAll === true,
						elementsCount: Array.isArray(parsed.payload?.elements)
							? parsed.payload.elements.length
							: 0,
					})
				}
			} catch {
				// Ignore frames that are not JSON scene payloads.
			}
		})

		hooks.sceneReceiveSpyInstalled = true
	})
}

async function clearReceivedSceneMessages(page: Page) {
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.receivedSceneMessages
		if (messages) {
			messages.length = 0
		} else if (win.__whiteboardTestHooks) {
			win.__whiteboardTestHooks.receivedSceneMessages = []
		}
	})
}

async function getReceivedSceneMessages(page: Page): Promise<ReceivedSceneMessage[]> {
	return page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		return win.__whiteboardTestHooks?.receivedSceneMessages || []
	})
}

async function resolveBoardFileId(page: Page, boardName: string): Promise<string> {
	await expect.poll(async () => resolveFileIdByDav(page, boardName), {
		timeout: 30000,
		intervals: [500],
	}).not.toBeNull()

	const fileId = await resolveFileIdByDav(page, boardName)
	if (!fileId) {
		throw new Error(`Failed to resolve file id for board: ${boardName}`)
	}
	return fileId
}

test.beforeEach(async ({ page }) => {
	await openFilesApp(page)
})

test('whiteboard changes sync across sessions', async ({ page, browser }) => {
	test.setTimeout(90000)
	const boardName = `Collab board ${Date.now()}`

	await enableWhiteboardTestHooks(page)
	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, 'First session text')
	const fileId = await resolveBoardFileId(page, boardName)
	await installSceneReceiveSpy(page)
	await clearReceivedSceneMessages(page)

	const pageB = await newLoggedInPage(page, browser)
	await enableWhiteboardTestHooks(pageB)
	await openWhiteboardById(pageB, fileId)

	await addTextElement(pageB, 'Second session text')
	await page.waitForFunction(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.receivedSceneMessages || []
		return messages.some((message: ReceivedSceneMessage) => (
			message.type === 'SCENE_UPDATE'
			&& message.syncAll === false
			&& message.elementsCount === 1
		))
	}, { timeout: 30000 })

	const receivedMessages = await getReceivedSceneMessages(page)
	expect(receivedMessages.some((message) => (
		message.type === 'SCENE_UPDATE'
		&& message.syncAll === false
		&& message.elementsCount === 1
	))).toBe(true)

	await pageB.close()
})

test('incremental scene sync sends only changed elements after targeted bootstrap', async ({ page, browser }) => {
	test.setTimeout(120000)
	const boardName = `Incremental collab board ${Date.now()}`
	const bootstrapText = 'Incremental bootstrap text'
	const deltaText = 'Incremental delta text'

	await enableWhiteboardTestHooks(page)
	await createWhiteboard(page, { name: boardName })
	await addTextElement(page, bootstrapText)
	const fileId = await resolveBoardFileId(page, boardName)
	await installSceneEmitSpy(page)
	await clearCapturedSceneMessages(page)
	await installSceneReceiveSpy(page)
	await clearReceivedSceneMessages(page)

	const pageB = await newLoggedInPage(page, browser)
	await enableWhiteboardTestHooks(pageB)
	await openWhiteboardById(pageB, fileId)

	await page.waitForFunction(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.emittedSceneMessages || []
		return messages.some((message: CapturedSceneMessage) => (
			message.transport === 'direct'
			&& message.type === 'SCENE_INIT'
		))
	}, { timeout: 30000 })

	const bootstrapMessages = await getCapturedSceneMessages(page)
	expect(bootstrapMessages.some((message) => (
		message.transport === 'direct'
		&& message.type === 'SCENE_INIT'
	))).toBe(true)
	expect(bootstrapMessages.some((message) => (
		message.transport === 'room'
		&& message.type === 'SCENE_INIT'
	))).toBe(false)

	await installSceneEmitSpy(pageB)
	await clearCapturedSceneMessages(pageB)

	await addTextElement(pageB, deltaText)

	await pageB.waitForFunction(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.emittedSceneMessages || []
		return messages.some((message: { type?: string, syncAll?: boolean, elementsCount?: number }) => (
			message.type === 'SCENE_UPDATE'
			&& message.syncAll === false
			&& message.elementsCount === 1
		))
	}, { timeout: 30000 })

	const messages = await getCapturedSceneMessages(pageB)
	const incrementalMessages = messages.filter((message) => message.type === 'SCENE_UPDATE')
	const receivedMessages = await getReceivedSceneMessages(page)

	expect(incrementalMessages.length).toBeGreaterThan(0)
	expect(incrementalMessages.some((message) => message.syncAll)).toBe(false)
	expect(incrementalMessages.every((message) => message.transport === 'room')).toBe(true)
	expect(messages.some((message) => message.type === 'SCENE_INIT')).toBe(false)
	expect(incrementalMessages.every((message) => message.elementsCount === 1)).toBe(true)
	expect(receivedMessages.some((message) => (
		message.type === 'SCENE_UPDATE'
		&& message.syncAll === false
		&& message.elementsCount === 1
	))).toBe(true)

	await pageB.close()
})
