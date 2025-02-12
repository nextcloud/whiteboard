/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test as setup } from '@playwright/test'
import { configureNextcloud, runOcc } from '@nextcloud/e2e-test-server'

/**
 * We use this to ensure Nextcloud is configured correctly before running our tests
 *
 * This can not be done in the webserver startup process,
 * as that only checks for the URL to be accessible which happens already before everything is configured.
 */
setup('Configure Nextcloud', async () => {
	setup.slow()
	const appsToInstall = [
		'whiteboard',
		'viewer',
	]
	await configureNextcloud(appsToInstall)
	await runOcc(['config:app:set', 'whiteboard', 'collabBackendUrl', '--value', 'http://localhost:3002'])
	await runOcc(['config:app:set', 'whiteboard', 'jwt_secret_key', '--value', 'secret'])
})
