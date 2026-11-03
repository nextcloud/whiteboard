/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyCollabConnection } from '../../src/utils/verifyCollabConnection.ts'

/**
 * A socket.io socket the test drives: `active` is false once the server refused it
 */
function fakeServer() {
	const events = {}
	const managerEvents = {}
	const socket = {
		active: true,
		on: (event, handler) => { events[event] = handler },
		off: vi.fn(),
		close: vi.fn(),
		io: { on: (event, handler) => { managerEvents[event] = handler }, off: vi.fn() },
	}
	const connect = vi.fn(() => socket)
	return {
		socket,
		connect,
		fail: (message, { refused = false } = {}) => {
			socket.active = !refused
			events.connect_error?.(new Error(message))
		},
		giveUp: () => managerEvents.reconnect_failed?.(),
	}
}

/**
 * @param {Promise<object>} result - The result of a check
 */
function settled(result) {
	let outcome = null
	result.then((value) => {
		outcome = value
	})
	return async () => {
		await Promise.resolve()
		return outcome
	}
}

describe('verifyCollabConnection', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('connects like the editor and reports the server answer for a valid secret', async () => {
		const server = fakeServer()
		const { result } = verifyCollabConnection('https://cloud.example.com/whiteboard/', 'jwt', server.connect)

		server.fail('Connection verified', { refused: true })

		expect(await result).toEqual({ verified: true })
		expect(server.connect).toHaveBeenCalledWith('https://cloud.example.com', {
			path: '/whiteboard/socket.io',
			withCredentials: true,
			auth: { secret: 'jwt' },
			transports: ['websocket'],
			reconnectionAttempts: 2,
		})
		expect(server.socket.close).toHaveBeenCalled()
	})

	it('keeps waiting through a slow first attempt', async () => {
		const server = fakeServer()
		const { result } = verifyCollabConnection('https://cloud.example.com/whiteboard', 'jwt', server.connect)
		const outcome = settled(result)

		server.fail('timeout')
		expect(await outcome()).toBeNull()

		server.fail('Connection verified', { refused: true })
		expect(await result).toEqual({ verified: true })
	})

	it('reports a wrong secret right away', async () => {
		const server = fakeServer()
		const { result } = verifyCollabConnection('https://cloud.example.com/whiteboard', 'jwt', server.connect)

		server.fail('Authentication error', { refused: true })

		expect(await result).toEqual({ verified: false, error: 'Authentication error' })
	})

	it('reports the last error once the retries are used up', async () => {
		const server = fakeServer()
		const { result } = verifyCollabConnection('https://cloud.example.com/whiteboard', 'jwt', server.connect)

		server.fail('timeout')
		server.fail('websocket error')
		server.giveUp()

		expect(await result).toEqual({ verified: false, error: 'websocket error' })
		expect(server.socket.close).toHaveBeenCalled()
	})

	it('gives up when the server never answers', async () => {
		vi.useFakeTimers()
		const server = fakeServer()
		const { result } = verifyCollabConnection('https://cloud.example.com/whiteboard', 'jwt', server.connect)

		await vi.advanceTimersByTimeAsync(75_000)

		expect(await result).toEqual({ verified: false, error: 'timeout' })
		expect(server.socket.close).toHaveBeenCalled()
	})

	it('reports an invalid URL without connecting', async () => {
		const server = fakeServer()
		const { result } = verifyCollabConnection('not a url', 'jwt', server.connect)

		expect((await result).verified).toBe(false)
		expect(server.connect).not.toHaveBeenCalled()
	})

	it('stops a check that is cancelled and ignores its late answer', async () => {
		const server = fakeServer()
		const { result, cancel } = verifyCollabConnection('https://cloud.example.com/whiteboard', 'jwt', server.connect)

		cancel()
		server.fail('Connection verified', { refused: true })

		expect(await result).toEqual({ verified: false, cancelled: true })
		expect(server.socket.close).toHaveBeenCalledOnce()
	})
})
