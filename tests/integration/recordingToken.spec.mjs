/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'
import { createConfigMock } from './configMock.js'

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({ JWT_SECRET_KEY: 'secret' }),
}))

const { getRecordingClaims, isSameRecordingUser, RECORDING_TOKEN_LIFETIME_SECONDS, signRecordingToken, withoutToken } = await import('../../websocket_server/Utilities/RecordingTokenUtility.js')

function userToken(claims) {
	return jwt.sign({
		userid: 'teacher',
		fileId: 42,
		isFileReadOnly: false,
		user: { id: 'teacher', name: 'Teacher' },
		...claims,
	}, 'secret', { expiresIn: 60 })
}

describe('recording tokens', () => {
	it('gives the bot a read-only token for the same user and board', () => {
		const claims = getRecordingClaims(userToken())
		const decoded = jwt.verify(signRecordingToken(claims, { readOnly: true }), 'secret')

		expect(decoded).toMatchObject({ userid: 'teacher', fileId: 42, isFileReadOnly: true, user: { id: 'teacher', name: 'Teacher' } })
		expect(decoded.exp - decoded.iat).toBe(RECORDING_TOKEN_LIFETIME_SECONDS)
	})

	it('signs a writable upload token that outlives the token the recording started with', () => {
		const started = userToken()
		const decoded = jwt.verify(signRecordingToken(getRecordingClaims(started), { readOnly: false }), 'secret')

		expect(decoded.isFileReadOnly).toBe(false)
		expect(decoded.exp).toBeGreaterThan(jwt.decode(started).exp)
	})

	it('never makes a read-only user writable', () => {
		const decoded = jwt.verify(signRecordingToken(getRecordingClaims(userToken({ isFileReadOnly: true })), { readOnly: false }), 'secret')

		expect(decoded.isFileReadOnly).toBe(true)
	})

	it('rejects tokens that are expired or not signed with the secret', () => {
		const expired = jwt.sign({ userid: 'teacher', fileId: 42, exp: Math.floor(Date.now() / 1000) - 10 }, 'secret')

		expect(() => getRecordingClaims(expired)).toThrow(jwt.TokenExpiredError)
		expect(() => getRecordingClaims(jwt.sign({ userid: 'teacher', fileId: 42 }, 'other'))).toThrow(jwt.JsonWebTokenError)
	})

	it('matches users by id, and guests by their share token', () => {
		expect(isSameRecordingUser('teacher', 'teacher')).toBe(true)
		expect(isSameRecordingUser('teacher', 'student')).toBe(false)
		expect(isSameRecordingUser('shared_AbCd123_1a2b', 'shared_AbCd123_9f8e')).toBe(true)
		expect(isSameRecordingUser('shared_AbCd123_1a2b', 'shared_Other99_1a2b')).toBe(false)
		expect(isSameRecordingUser('shared_AbCd123_1a2b', 'AbCd123')).toBe(false)
		expect(isSameRecordingUser(undefined, 'teacher')).toBe(false)
	})

	it('keeps tokens out of logged URLs', () => {
		expect(withoutToken('https://cloud.example/apps/whiteboard/recording/42/teacher?token=abc&lang=de'))
			.toBe('https://cloud.example/apps/whiteboard/recording/42/teacher?lang=de')
	})
})
