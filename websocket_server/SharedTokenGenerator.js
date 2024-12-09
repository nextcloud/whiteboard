/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'crypto'
import Config from './Config.js'

export default class SharedTokenGenerator {

	handle(roomId) {
		const timestamp = Date.now()
		const payload = `${roomId}:${timestamp}`
		const hmac = crypto.createHmac('sha256', Config.JWT_SECRET_KEY)
		hmac.update(payload)
		const signature = hmac.digest('hex')
		return `${payload}:${signature}`
	}

}
