/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = []
vi.mock('@nextcloud/dialogs', () => ({
	showWarning: vi.fn((text, options) => {
		const toast = { text, options, hidden: false, hideToast: vi.fn(() => {
			toast.hidden = true
			options.onRemove?.()
		}) }
		toasts.push(toast)
		return toast
	}),
}))
vi.mock('@nextcloud/excalidraw', () => ({ CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' }, restoreElements: (elements) => elements, restoreAppState: (appState) => appState }))
vi.mock('@nextcloud/auth', () => ({ getCurrentUser: () => ({ uid: 'alice' }) }))
const axiosGet = vi.hoisted(() => vi.fn())
vi.mock('@nextcloud/axios', () => ({ default: { get: axiosGet } }))
vi.mock('@nextcloud/router', () => ({ generateUrl: (path) => `/index.php/${path}` }))
const kept = vi.hoisted(() => ({ entries: [] }))
vi.mock('../../src/sync/localBoardStore.ts', () => {
	const localBoardStore = {
		recovered: vi.fn(async () => ({ keys: kept.entries.map((entry) => entry.key), elements: kept.entries.flatMap((entry) => entry.elements), files: {} })),
		dropRecovered: vi.fn(async (keys) => {
			kept.entries = kept.entries.filter((entry) => !keys.includes(entry.key))
		}),
	}
	localBoardStore.board = (account, fileId) => ({ recovered: () => localBoardStore.recovered(account, fileId), dropRecovered: (keys) => localBoardStore.dropRecovered(keys) })
	return { localBoardStore, legacyDraft: async () => null, dropLegacyDraft: async () => {} }
})

const { createBoardSync } = await import('../../src/sync/createBoardSync.ts')
const { setBoardSync } = await import('../../src/sync/boardSync.ts')
const { localBoardStore } = await import('../../src/sync/localBoardStore.ts')
const { useJWTStore } = await import('../../src/stores/useJwtStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')

/** A token as the server makes it, for board `fileId` */
function token(fileId, name = 'x') {
	const now = Math.floor(Date.now() / 1000)
	const payload = btoa(JSON.stringify({ userid: 'alice', fileId, isFileReadOnly: false, user: { id: 'alice', name: 'Alice' }, iat: now, exp: now + 900, name }))
	return `h.${payload}.s`
}

/** A response whose body arrives in chunks the test sends; reading fails once the request is aborted */
function streamed(signal, status = 200) {
	let push = null
	let end = null
	const body = new ReadableStream({
		start(controller) {
			push = (text) => controller.enqueue(new TextEncoder().encode(text))
			end = () => controller.close()
			signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')))
		},
	})
	return { response: new Response(body, { status, headers: { 'Content-Type': 'application/json' } }), push: (text) => push(text), end: () => end() }
}

async function flush() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

describe('recovery notice', () => {
	beforeEach(() => {
		toasts.length = 0
		vi.clearAllMocks()
		kept.entries = [{ key: 1, elements: [{ id: 'a', version: 2, versionNonce: 2 }] }, { key: 2, elements: [] }]
	})

	afterEach(() => {
		setBoardSync(null)
	})

	it('shows one notice per board while it is open', () => {
		const sync = createBoardSync(11, 'alice')

		sync.options.onRecoverable(false)
		sync.options.onRecoverable(false)

		expect(toasts).toHaveLength(1)
	})

	it('adds the changes back and closes the notice when it is clicked', async () => {
		const sync = createBoardSync(12, 'alice')
		sync.addRecovered = vi.fn(async () => true)
		setBoardSync(sync)
		sync.options.onRecoverable(true)

		await toasts[0].options.onClick()
		await flush()

		expect(sync.addRecovered).toHaveBeenCalled()
		expect(toasts[0].hidden).toBe(true)
		expect(localBoardStore.dropRecovered).toHaveBeenCalledTimes(1)
		expect(localBoardStore.dropRecovered).toHaveBeenCalledWith([1, 2])
	})

	it('offers the changes again when adding them back fails', async () => {
		const sync = createBoardSync(16, 'alice')
		sync.addRecovered = vi.fn(async () => {
			throw new Error('QuotaExceededError')
		})
		setBoardSync(sync)
		sync.options.onRecoverable(true)

		await expect(toasts[0].options.onClick()).resolves.toBeUndefined()
		await flush()

		expect(localBoardStore.dropRecovered).not.toHaveBeenCalled()
		expect(toasts).toHaveLength(2)
		expect(toasts[1].hidden).toBe(false)
	})

	it('offers the changes again when the board cannot take them yet', async () => {
		const sync = createBoardSync(17, 'alice')
		sync.addRecovered = vi.fn(async () => false)
		setBoardSync(sync)
		sync.options.onRecoverable(true)

		await toasts[0].options.onClick()
		await flush()

		expect(localBoardStore.dropRecovered).not.toHaveBeenCalled()
		expect(toasts).toHaveLength(2)
		expect(toasts[1].hidden).toBe(false)
	})

	it('offers the changes again when the board opens after its notice was clicked while it was closed', async () => {
		const sync = createBoardSync(18, 'alice')
		setBoardSync(sync)
		sync.options.onRecoverable(true)
		setBoardSync(null)

		await toasts[0].options.onClick()
		await flush()
		expect(toasts).toHaveLength(1)
		createBoardSync(18, 'alice').options.onRecoverable(true)

		expect(localBoardStore.dropRecovered).not.toHaveBeenCalled()
		expect(toasts).toHaveLength(2)
	})

	it('discards the changes when the notice is closed', async () => {
		const sync = createBoardSync(13, 'alice')
		sync.addRecovered = vi.fn(async () => true)
		setBoardSync(sync)
		sync.options.onRecoverable(true)

		toasts[0].hideToast()
		await flush()

		expect(sync.addRecovered).not.toHaveBeenCalled()
		expect(localBoardStore.dropRecovered).toHaveBeenCalledWith([1, 2])
		expect(toasts).toHaveLength(1)
		sync.options.onRecoverable(false)
		expect(toasts).toHaveLength(2)
	})

	it('discards only what the notice offered, and offers what was kept after it appeared', async () => {
		const sync = createBoardSync(15, 'alice')
		setBoardSync(sync)
		sync.options.onRecoverable(true)
		await flush()
		// The board changed again while the notice was open
		kept.entries.push({ key: 3, elements: [{ id: 'b', version: 1, versionNonce: 1 }] })

		toasts[0].hideToast()
		await flush()

		expect(localBoardStore.dropRecovered).toHaveBeenCalledWith([1, 2])
		expect(kept.entries.map((entry) => entry.key)).toEqual([3])
		expect(toasts).toHaveLength(2)
	})

	it('says what closing the notice does', () => {
		const sync = createBoardSync(14, 'alice')

		sync.options.onRecoverable(true)

		expect(toasts[0].text).toMatch(/close this message to discard them/)
	})
})

describe('board requests', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		axiosGet.mockReset()
		useJWTStore.getState().clearTokens()
		useWhiteboardConfigStore.setState({ fileId: 21, publicSharingToken: null, isReadOnly: false })
		useJWTStore.setState({ tokens: { 21: token(21) }, tokenExpiries: { 21: Math.floor(Date.now() / 1000) + 900 } })
	})

	afterEach(() => {
		vi.useRealTimers()
		delete globalThis.fetch
	})

	it('aborts a board request that receives nothing for a minute', async () => {
		let stream = null
		globalThis.fetch = vi.fn(async (url, init) => {
			stream = streamed(init.signal)
			return stream.response
		})
		const request = createBoardSync(21, 'alice').options.request

		const answer = request('GET').then(() => 'answered', () => 'failed')
		await vi.advanceTimersByTimeAsync(1_000)
		stream.push('{"sync":')
		await vi.advanceTimersByTimeAsync(61_000)

		expect(await answer).toBe('failed')
		expect(globalThis.fetch.mock.calls[0][1].signal.aborted).toBe(true)
	})

	it('finishes a slow board download that keeps receiving', async () => {
		let stream = null
		globalThis.fetch = vi.fn(async (url, init) => {
			stream = streamed(init.signal)
			return stream.response
		})
		const request = createBoardSync(21, 'alice').options.request

		const answer = request('GET')
		for (const part of ['{"sync":', '{"epoch":"e1","rev":3}', ',"data":{"elements":[]}', '}']) {
			await vi.advanceTimersByTimeAsync(40_000)
			stream.push(part)
		}
		stream.end()

		expect(await answer).toEqual({ status: 200, body: { sync: { epoch: 'e1', rev: 3 }, data: { elements: [] } } })
	})

	it('sends the last save of a closed board with its own token after another board opened', async () => {
		globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }))
		const request = createBoardSync(21, 'alice').options.request
		useWhiteboardConfigStore.setState({ fileId: 22 })
		useJWTStore.setState((state) => ({ tokens: { ...state.tokens, 22: token(22) }, tokenExpiries: { ...state.tokenExpiries, 22: Math.floor(Date.now() / 1000) + 900 } }))

		await request('PUT', { body: {} })

		expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token(21)}`)
	})

	it('asks Nextcloud for a new token for the last save of a closed board once its token expired', async () => {
		const fresh = token(23, 'fresh')
		axiosGet.mockResolvedValue({ data: { token: fresh } })
		globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }))
		const request = createBoardSync(23, 'alice').options.request
		useWhiteboardConfigStore.setState({ fileId: 24 })
		useJWTStore.setState((state) => ({ tokens: { ...state.tokens, 23: token(23) }, tokenExpiries: { ...state.tokenExpiries, 23: Math.floor(Date.now() / 1000) - 10 } }))

		await request('PUT', { body: {} })

		expect(axiosGet.mock.calls[0][0]).toBe('/index.php/apps/whiteboard/23/token')
		expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${fresh}`)
		expect(useWhiteboardConfigStore.getState().fileId).toBe(24)
	})

	it('asks Nextcloud for a new token when it refuses the cached token of a closed board', async () => {
		const fresh = token(25, 'fresh')
		axiosGet.mockResolvedValue({ data: { token: fresh } })
		globalThis.fetch = vi.fn(async (url, init) => init.headers.Authorization === `Bearer ${fresh}`
			? new Response('{"ok":true}', { status: 200 })
			: new Response('{}', { status: 401 }))
		const request = createBoardSync(25, 'alice').options.request
		useWhiteboardConfigStore.setState({ fileId: 26 })
		useJWTStore.setState((state) => ({ tokens: { ...state.tokens, 25: token(25, 'stale') }, tokenExpiries: { ...state.tokenExpiries, 25: Math.floor(Date.now() / 1000) + 900 } }))

		const answer = await request('PUT', { body: {} })

		expect(answer.status).toBe(200)
		expect(axiosGet.mock.calls[0][0]).toBe('/index.php/apps/whiteboard/25/token')
		expect(useWhiteboardConfigStore.getState().fileId).toBe(26)
	})

	it('asks for a new token and tries once more when Nextcloud refuses the token', async () => {
		const fresh = token(21, 'fresh')
		axiosGet.mockResolvedValue({ data: { token: fresh } })
		globalThis.fetch = vi.fn(async (url, init) => init.headers.Authorization === `Bearer ${fresh}`
			? new Response('{"ok":true}', { status: 200 })
			: new Response('{}', { status: 401 }))
		const request = createBoardSync(21, 'alice').options.request

		const answer = await request('GET')

		expect(answer.status).toBe(200)
		expect(globalThis.fetch).toHaveBeenCalledTimes(2)
	})

	it('gives up a token request that does not answer within 30 seconds', async () => {
		useJWTStore.getState().clearTokens()
		axiosGet.mockImplementation((url, config) => new Promise((resolve, reject) => {
			config?.signal?.addEventListener('abort', () => reject(new Error('canceled')))
		}))

		const first = useJWTStore.getState().getJWT().then((jwt) => jwt ?? 'none')
		await vi.advanceTimersByTimeAsync(31_000)

		expect(await first).toBe('none')
		axiosGet.mockResolvedValue({ data: { token: token(21) } })
		expect(await useJWTStore.getState().getJWT()).toBe(token(21))
	})
})

describe('ending a text edit before the board is replaced', () => {
	afterEach(() => {
		document.body.innerHTML = ''
	})

	it('submits the text also while a click in the properties panel has turned off its blur', () => {
		const editable = document.createElement('textarea')
		editable.className = 'excalidraw-wysiwyg'
		document.body.append(editable)
		const submit = vi.fn()
		// As Excalidraw's text editor: Escape submits; a click in the properties panel sets onblur to null
		editable.onkeydown = (event) => {
			if (event.key === 'Escape') {
				submit()
			}
		}
		editable.onblur = null
		const elsewhere = vi.fn()
		document.addEventListener('keydown', elsewhere)

		createBoardSync(31, 'alice').options.endEditing()

		expect(submit).toHaveBeenCalledTimes(1)
		expect(elsewhere).not.toHaveBeenCalled()
		document.removeEventListener('keydown', elsewhere)
	})
})
