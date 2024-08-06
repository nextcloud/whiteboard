/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'crypto'
import dotenv from 'dotenv'

dotenv.config()

class AuthManager {

	constructor() {
		this.SHARED_SECRET = process.env.JWT_SECRET_KEY
	}

	generateSharedToken(roomId) {
		const timestamp = Date.now()
		const payload = `${roomId}:${timestamp}`
		const hmac = crypto.createHmac('sha256', this.SHARED_SECRET)
		hmac.update(payload)
		const signature = hmac.digest('hex')
		return `${payload}:${signature}`
	}

}

export default AuthManager
