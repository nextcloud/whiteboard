/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'crypto'
import dotenv from 'dotenv'

dotenv.config()

const SHARED_SECRET = process.env.JWT_SECRET_KEY

export function generateSharedToken(roomId) {
	const timestamp = Date.now()
	const payload = `${roomId}:${timestamp}`
	const hmac = crypto.createHmac('sha256', SHARED_SECRET)
	hmac.update(payload)
	const signature = hmac.digest('hex')
	return `${payload}:${signature}`
}
