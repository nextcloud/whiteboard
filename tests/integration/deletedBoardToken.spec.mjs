/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const axiosGet = vi.hoisted(() => vi.fn())

vi.mock('@nextcloud/axios', () => ({ default: { get: axiosGet } }))
vi.mock('@nextcloud/router', () => ({ generateUrl: (url) => url }))

const { useJWTStore } = await import('../../src/stores/useJwtStore.ts')
const { useCollaborationStore } = await import('../../src/stores/useCollaborationStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')

function httpError(status) {
	return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })
}

describe('token of a deleted board', () => {
	beforeEach(() => {
		axiosGet.mockReset()
		useWhiteboardConfigStore.setState({ fileId: 1, publicSharingToken: null, isReadOnly: false })
		useCollaborationStore.getState().clearAuthError()
		useJWTStore.getState().clearTokens()
	})

	it('stops asking for tokens once the board is gone', async () => {
		axiosGet.mockRejectedValue(httpError(404))

		await expect(useJWTStore.getState().getJWT()).resolves.toBeNull()
		await useJWTStore.getState().getJWT()
		await useJWTStore.getState().refreshJWT()

		expect(axiosGet).toHaveBeenCalledTimes(1)
		expect(useCollaborationStore.getState().authError).toMatchObject({ type: 'not_found', isPersistent: true })
		expect(useWhiteboardConfigStore.getState().isReadOnly).toBe(true)
	})

	it('ignores a 404 that arrives after another board was opened', async () => {
		let reject
		axiosGet.mockReturnValueOnce(new Promise((resolve, fail) => {
			reject = fail
		}))

		const request = useJWTStore.getState().refreshJWT()
		useWhiteboardConfigStore.setState({ fileId: 2 })
		reject(httpError(404))
		await request

		expect(useCollaborationStore.getState().authError.isPersistent).toBe(false)
		expect(useWhiteboardConfigStore.getState().isReadOnly).toBe(false)
	})

	it('retries a failed scheduled refresh after a pause', async () => {
		vi.useFakeTimers()
		try {
			const encode = (part) => btoa(JSON.stringify(part)).replace(/=+$/, '')
			const now = Math.floor(Date.now() / 1000)
			const token = `${encode({ alg: 'HS256' })}.${encode({ userid: 'alice', fileId: 1, iat: now - 840, exp: now + 60 })}.signature`
			useJWTStore.setState({ tokens: { 1: token }, tokenExpiries: { 1: now + 60 } })
			axiosGet.mockRejectedValue(httpError(500))

			useJWTStore.getState().setupAutoRefresh('1')
			await vi.advanceTimersByTimeAsync(10_000)
			expect(axiosGet).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(30_000)
			expect(axiosGet).toHaveBeenCalledTimes(2)
		} finally {
			useJWTStore.getState().clearTokens()
			vi.useRealTimers()
		}
	})

	it('still gets tokens to save to Nextcloud when the collaboration server keeps refusing them', async () => {
		const encode = (part) => btoa(JSON.stringify(part)).replace(/=+$/, '')
		const now = Math.floor(Date.now() / 1000)
		const token = `${encode({ alg: 'HS256' })}.${encode({ userid: 'alice', fileId: 1, iat: now, exp: now + 900 })}.signature`
		axiosGet.mockResolvedValue({ data: { token } })
		for (let i = 0; i < 5; i++) {
			useCollaborationStore.getState().incrementAuthFailure('jwt_secret_mismatch', 'WebSocket authentication failed')
		}
		expect(useCollaborationStore.getState().authError.isPersistent).toBe(true)

		await expect(useJWTStore.getState().getJWT()).resolves.toBe(token)
		expect(useWhiteboardConfigStore.getState().isReadOnly).toBe(false)
	})

	it('keeps refreshing the token before it expires when the collaboration server keeps refusing it', async () => {
		vi.useFakeTimers()
		try {
			const encode = (part) => btoa(JSON.stringify(part)).replace(/=+$/, '')
			const now = Math.floor(Date.now() / 1000)
			const token = `${encode({ alg: 'HS256' })}.${encode({ userid: 'alice', fileId: 1, iat: now - 840, exp: now + 60 })}.signature`
			useJWTStore.setState({ tokens: { 1: token }, tokenExpiries: { 1: now + 60 } })
			axiosGet.mockResolvedValue({ data: { token } })
			for (let i = 0; i < 5; i++) {
				useCollaborationStore.getState().incrementAuthFailure('jwt_secret_mismatch', 'WebSocket authentication failed')
			}

			useJWTStore.getState().setupAutoRefresh('1')
			await vi.advanceTimersByTimeAsync(10_000)

			expect(axiosGet).toHaveBeenCalledTimes(1)
		} finally {
			useJWTStore.getState().clearTokens()
			vi.useRealTimers()
		}
	})

	it('keeps retrying after a server error', async () => {
		axiosGet.mockRejectedValue(httpError(500))

		await useJWTStore.getState().getJWT()
		await useJWTStore.getState().getJWT()

		expect(axiosGet).toHaveBeenCalledTimes(2)
		expect(useCollaborationStore.getState().authError.isPersistent).toBe(false)
	})
})
