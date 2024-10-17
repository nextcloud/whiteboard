/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import crypto from 'crypto'
import dotenv from 'dotenv'

dotenv.config()

export default function getOrCreateJwtSecretKey() {
	if (!process.env.JWT_SECRET_KEY) {
		const newSecret = crypto.randomBytes(32).toString('hex')
		process.env.JWT_SECRET_KEY = newSecret
		console.log('Generated new JWT_SECRET_KEY:', newSecret)
	} else {
		console.log('Using existing JWT_SECRET_KEY from environment')
	}
	return process.env.JWT_SECRET_KEY
}
