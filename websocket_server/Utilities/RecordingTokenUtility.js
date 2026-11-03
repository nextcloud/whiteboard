/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import jwt from 'jsonwebtoken'
import Config from './ConfigUtility.js'

// Same lifetime as the tokens Nextcloud issues (JWTConsts::EXPIRATION_TIME)
export const RECORDING_TOKEN_LIFETIME_SECONDS = 15 * 60

/**
 * Verifies the recording user's token and returns the claims a recording reuses.
 *
 * @param {string} token JWT the user started the recording with
 * @return {{userid: string, fileId: number, isFileReadOnly: boolean, user: object}}
 */
export function getRecordingClaims(token) {
	const { userid, fileId, isFileReadOnly, user } = jwt.verify(token, Config.JWT_SECRET_KEY, { algorithms: ['HS256'] })
	return { userid, fileId, isFileReadOnly, user }
}

/**
 * Signs a fresh token for the recording user. Recordings outlive the user's
 * token, so the bot and the final upload need tokens of their own.
 *
 * @param {object} claims claims from getRecordingClaims()
 * @param {object} options options
 * @param {boolean} options.readOnly whether the token may only read the board
 * @return {string}
 */
export function signRecordingToken(claims, { readOnly }) {
	return jwt.sign(
		{ ...claims, isFileReadOnly: readOnly || claims.isFileReadOnly },
		Config.JWT_SECRET_KEY,
		{ algorithm: 'HS256', expiresIn: RECORDING_TOKEN_LIFETIME_SECONDS },
	)
}

/**
 * Whether a token belongs to the user of a socket. Guests get a new random id
 * with every token, so they are matched by their share token.
 *
 * @param {string} tokenUserId user id in the token
 * @param {string} socketUserId user id of the socket
 * @return {boolean}
 */
export function isSameRecordingUser(tokenUserId, socketUserId) {
	if (typeof tokenUserId !== 'string' || typeof socketUserId !== 'string') {
		return false
	}
	if (tokenUserId.startsWith('shared_') && socketUserId.startsWith('shared_')) {
		return tokenUserId.split('_')[1] === socketUserId.split('_')[1]
	}
	return tokenUserId === socketUserId
}

/**
 * @param {string} url recording page URL
 * @return {string} the URL without its token, for logs
 */
export function withoutToken(url) {
	const parsed = new URL(url)
	parsed.searchParams.delete('token')
	return parsed.toString()
}
