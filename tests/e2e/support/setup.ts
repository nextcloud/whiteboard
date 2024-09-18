import { test as setup } from '@playwright/test'
import { configureNextcloud, docker } from '@nextcloud/cypress/docker'

/**
 * We use this to ensure Nextcloud is configured correctly before running our tests
 *
 * This can not be done in the webserver startup process,
 * as that only checks for the URL to be accessible which happens already before everything is configured.
 */
setup('Configure Nextcloud', async () => {
	const containerName = 'nextcloud-nextcloud-1' // 'nextcloud-cypress-tests_whiteboard'
	const container = docker.getContainer(containerName)
	await configureNextcloud(['whiteboard', 'viewer'], undefined, container)
})
