/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'http'
import https from 'https'
import Config from './Utilities/ConfigUtility.js'

const client = Config.USE_TLS ? https : http
const host = ['0.0.0.0', '::'].includes(Config.HOST) ? 'localhost' : Config.HOST

// The certificate is issued for the public host name, not for the address checked here
client.get({ host, port: Config.PORT, rejectUnauthorized: false }, (res) => {
	process.exit(res.statusCode === 200 ? 0 : 1)
})
