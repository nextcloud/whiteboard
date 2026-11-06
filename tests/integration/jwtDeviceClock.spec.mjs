/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const axiosGet = vi.hoisted(() => vi.fn())

vi.mock('@nextcloud/axios', () => ({ default: { get: axiosGet } }))
vi.mock('@nextcloud/router', () => ({ generateUrl: (url) => url }))

const { useJWTStore } = await import('../../src/stores/useJwtStore.ts')
const { useCollaborationStore } = await import('../../src/stores/useCollaborationStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')

const SERVER_NOW = Date.UTC(2026, 10, 3, 12, 0, 0) / 1000
const LIFETIME = 15 * 60

function serverToken() {
	const encode = (part) => btoa(JSON.stringify(part)).replace(/=+$/, '')
	const payload = { userid: 'alice', fileId: 1, isFileReadOnly: false, user: { id: 'alice', name: 'Alice' }, iat: SERVER_NOW, exp: SERVER_NOW + LIFETIME }
	return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

describe.each([
	['behind', -3600],
	['ahead of', 3600],
])('a device clock an hour %s the server', (_, offset) => {
	const deviceNow = SERVER_NOW + offset

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(deviceNow * 1000)
		axiosGet.mockResolvedValue({ data: { token: serverToken() } })
		useWhiteboardConfigStore.setState({ fileId: 1, publicSharingToken: null, isReadOnly: false })
		useCollaborationStore.getState().clearAuthError()
		useJWTStore.getState().clearTokens()
	})

	afterEach(() => {
		useJWTStore.getState().clearTokens()
		vi.useRealTimers()
	})

	it('accepts a fresh token and keeps the board editable', async () => {
		await expect(useJWTStore.getState().getJWT()).resolves.toBe(serverToken())

		expect(useWhiteboardConfigStore.getState().isReadOnly).toBe(false)
		expect(useCollaborationStore.getState().authError.consecutiveFailures).toBe(0)
	})

	it('refreshes the token before its lifetime runs out on this device', async () => {
		await useJWTStore.getState().getJWT()

		expect(useJWTStore.getState().tokenExpiries[1]).toBe(deviceNow + LIFETIME)
		expect(useJWTStore.getState().isTokenExpired('1')).toBe(false)

		axiosGet.mockClear()
		await vi.advanceTimersByTimeAsync((LIFETIME - 90) * 1000)

		expect(axiosGet).toHaveBeenCalledTimes(1)
	})
})

describe('tokens stored by an earlier version', () => {
	it('are dropped, since their expiry used the server clock', async () => {
		localStorage.setItem('jwt-storage', JSON.stringify({
			state: { tokens: { 1: serverToken() }, tokenExpiries: { 1: SERVER_NOW + LIFETIME } },
			version: 2,
		}))

		await useJWTStore.persist.rehydrate()

		expect(useJWTStore.getState().tokens).toEqual({})
		expect(useJWTStore.getState().tokenExpiries).toEqual({})
	})
})
