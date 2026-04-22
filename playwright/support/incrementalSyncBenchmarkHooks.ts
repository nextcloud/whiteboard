/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Page } from '@playwright/test'
import type { ElementSnapshot } from './incrementalSyncBenchmarkFixtures'

type CapturedSceneMessage = {
	transport: 'room' | 'direct'
	type: string
	syncAll: boolean
	elementsCount: number
	payloadBytes: number
	emittedAt: number
}

type ReceivedSceneMessage = {
	type: string
	syncAll: boolean
	elementsCount: number
	payloadBytes: number
	receivedAt: number
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
				getSceneElementsIncludingDeleted?: () => Array<Record<string, unknown>>
				updateScene?: (scene: Record<string, unknown>) => void
			}
		}
	}
	benchmarkSceneMessages?: CapturedSceneMessage[]
	benchmarkSceneEmitSpyInstalled?: boolean
	benchmarkReceivedSceneMessages?: ReceivedSceneMessage[]
	benchmarkSceneReceiveSpyInstalled?: boolean
}

type WhiteboardTestWindow = Window & {
	__whiteboardTest?: boolean
	__whiteboardTestHooks?: WhiteboardTestHooks
}

export async function enableWhiteboardTestHooks(page: Page) {
	await page.addInitScript(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTest = true
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		win.__whiteboardTestHooks.benchmarkSceneMessages = []
		win.__whiteboardTestHooks.benchmarkReceivedSceneMessages = []
	})

	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTest = true
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		win.__whiteboardTestHooks.benchmarkSceneMessages = win.__whiteboardTestHooks.benchmarkSceneMessages || []
		win.__whiteboardTestHooks.benchmarkReceivedSceneMessages = win.__whiteboardTestHooks.benchmarkReceivedSceneMessages || []
	})
}

export async function waitForCollaborationReady(page: Page) {
	await page.waitForFunction(() => {
		const win = window as WhiteboardTestWindow
		const store = win.__whiteboardTestHooks?.collaborationStore
		const state = store?.getState?.()
		return Boolean(state?.socket?.connected && state?.isInRoom)
	}, { timeout: 60_000 })
}

export async function installSceneEmitSpy(page: Page) {
	await waitForCollaborationReady(page)
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		const hooks = win.__whiteboardTestHooks
		hooks.benchmarkSceneMessages = hooks.benchmarkSceneMessages || []
		if (hooks.benchmarkSceneEmitSpyInstalled) {
			return
		}

		const socket = hooks.collaborationStore?.getState?.().socket
		if (!socket) {
			throw new Error('Collaboration socket not available')
		}

		const encoder = new TextEncoder()
		const bytesForPayload = (payload: unknown) => {
			if (typeof payload === 'string') {
				return encoder.encode(payload).byteLength
			}
			if (payload instanceof ArrayBuffer) {
				return payload.byteLength
			}
			if (ArrayBuffer.isView(payload)) {
				return payload.byteLength
			}
			if (payload) {
				return encoder.encode(JSON.stringify(payload)).byteLength
			}
			return 0
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
				const rawPayload = eventName === 'server-direct-broadcast' ? args[2] : args[1]
				const decoded = decodePayload(rawPayload)
				if (decoded) {
					try {
						const parsed = JSON.parse(decoded)
						if (parsed?.type === 'SCENE_INIT' || parsed?.type === 'SCENE_UPDATE') {
							hooks.benchmarkSceneMessages?.push({
								transport: eventName === 'server-direct-broadcast' ? 'direct' : 'room',
								type: parsed.type,
								syncAll: parsed.payload?.syncAll === true,
								elementsCount: Array.isArray(parsed.payload?.elements) ? parsed.payload.elements.length : 0,
								payloadBytes: bytesForPayload(rawPayload),
								emittedAt: Date.now(),
							})
						}
					} catch {
						// Ignore non-scene payloads.
					}
				}
			}
			return originalEmit(eventName, ...args)
		}

		hooks.benchmarkSceneEmitSpyInstalled = true
	})
}

export async function clearCapturedSceneMessages(page: Page) {
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.benchmarkSceneMessages
		if (messages) {
			messages.length = 0
		}
	})
}

export async function getCapturedSceneMessages(page: Page): Promise<CapturedSceneMessage[]> {
	return page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		return win.__whiteboardTestHooks?.benchmarkSceneMessages || []
	})
}

export async function installSceneReceiveSpy(page: Page) {
	await waitForCollaborationReady(page)
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		win.__whiteboardTestHooks = win.__whiteboardTestHooks || {}
		const hooks = win.__whiteboardTestHooks
		hooks.benchmarkReceivedSceneMessages = hooks.benchmarkReceivedSceneMessages || []
		if (hooks.benchmarkSceneReceiveSpyInstalled) {
			return
		}

		const socket = hooks.collaborationStore?.getState?.().socket
		if (!socket) {
			throw new Error('Collaboration socket not available')
		}

		const encoder = new TextEncoder()
		const bytesForPayload = (payload: unknown) => {
			if (typeof payload === 'string') {
				return encoder.encode(payload).byteLength
			}
			if (payload instanceof ArrayBuffer) {
				return payload.byteLength
			}
			if (ArrayBuffer.isView(payload)) {
				return payload.byteLength
			}
			if (payload) {
				return encoder.encode(JSON.stringify(payload)).byteLength
			}
			return 0
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
					hooks.benchmarkReceivedSceneMessages?.push({
						type: parsed.type,
						syncAll: parsed.payload?.syncAll === true,
						elementsCount: Array.isArray(parsed.payload?.elements) ? parsed.payload.elements.length : 0,
						payloadBytes: bytesForPayload(args[0]),
						receivedAt: Date.now(),
					})
				}
			} catch {
				// Ignore non-scene payloads.
			}
		})

		hooks.benchmarkSceneReceiveSpyInstalled = true
	})
}

export async function clearReceivedSceneMessages(page: Page) {
	await page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		const messages = win.__whiteboardTestHooks?.benchmarkReceivedSceneMessages
		if (messages) {
			messages.length = 0
		}
	})
}

export async function getReceivedSceneMessages(page: Page): Promise<ReceivedSceneMessage[]> {
	return page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		return win.__whiteboardTestHooks?.benchmarkReceivedSceneMessages || []
	})
}

export async function injectScene(page: Page, elements: Array<Record<string, unknown>>) {
	await waitForCollaborationReady(page)
	await page.evaluate((sceneElements) => {
		const win = window as WhiteboardTestWindow
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		if (!api?.updateScene) {
			throw new Error('Excalidraw API not available')
		}
		api.updateScene({ elements: sceneElements })
	}, elements)
}

export async function waitForSceneElementCount(page: Page, expectedCount: number, timeout = 60_000) {
	await page.waitForFunction((count) => {
		const win = window as WhiteboardTestWindow
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		const elements = api?.getSceneElementsIncludingDeleted?.() || []
		return elements.length === count
	}, expectedCount, { timeout })
}

export async function waitForElementSnapshots(page: Page, expectedElements: ElementSnapshot[], timeout = 60_000) {
	await page.waitForFunction((snapshots) => {
		const win = window as WhiteboardTestWindow
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		const elements = api?.getSceneElementsIncludingDeleted?.() || []
		if (!elements.length) {
			return false
		}

		const current = new Map(elements.map((element) => [String(element.id), element]))
		return snapshots.every((snapshot) => {
			const element = current.get(snapshot.id)
			if (!element) {
				return false
			}
			if (Number(element.version) !== snapshot.version) {
				return false
			}
			if (Boolean(element.isDeleted) !== snapshot.isDeleted) {
				return false
			}
			if (snapshot.type === 'text') {
				const currentText = String(element.text ?? element.originalText ?? '')
				const expectedText = String(snapshot.text ?? snapshot.originalText ?? '')
				if (currentText !== expectedText) {
					return false
				}
			}
			return true
		})
	}, expectedElements, { timeout })
}

export async function getScenePayloadBytes(page: Page, type: 'SCENE_INIT' | 'SCENE_UPDATE') {
	return page.evaluate((messageType) => {
		const win = window as WhiteboardTestWindow
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		const elements = api?.getSceneElementsIncludingDeleted?.() || []
		return new TextEncoder().encode(JSON.stringify({
			type: messageType,
			payload: { elements },
		})).byteLength
	}, type)
}

export async function getSceneElements(page: Page) {
	return page.evaluate(() => {
		const win = window as WhiteboardTestWindow
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		return api?.getSceneElementsIncludingDeleted?.() || []
	})
}
