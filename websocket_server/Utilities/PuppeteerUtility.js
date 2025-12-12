/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { launch as launchChromium } from 'puppeteer-core'
import Config from './ConfigUtility.js'

const CHECK_INTERVAL_MS = 60_000
const TEST_TIMEOUT_MS = 10_000

let cachedResult = null
let lastCheckedAt = 0
let pendingCheck = null

function buildReasonMessage(error) {
	if (!error) {
		return 'Recording requires a Chromium-based browser. Install Chromium and restart the collaboration server.'
	}

	const rawMessage = error?.message || `${error}`

	if (rawMessage.includes('Could not find Chromium') || rawMessage.includes('Could not find expected browser')) {
		return 'Chromium is missing. Install a system Chromium package or allow Puppeteer to download one (see README “Recording prerequisites”).'
	}

	if (rawMessage.includes('no usable sandbox!')) {
		return 'Chromium failed to start because the OS sandbox is unavailable. Either run the server as a non-root user or keep the --no-sandbox flag enabled.'
	}

	if (rawMessage.includes('error while loading shared libraries')) {
		return 'Chromium failed to start because required shared libraries are missing. Install the recommended system packages for headless Chromium (see README “Recording prerequisites”).'
	}

	return `Chromium failed to start (${rawMessage}). Install the required browser dependencies and restart the collaboration server.`
}

async function runLaunchCheck() {
	try {
		// Use Config-based Chrome detection
		const browser = await launchChromium({
			headless: 'new',
			args: ['--no-sandbox', '--disable-setuid-sandbox'],
			timeout: TEST_TIMEOUT_MS,
			executablePath: Config.CHROME_EXECUTABLE_PATH,
		})

		await browser.close()

		return { available: true, reason: null }
	} catch (error) {
		console.error('[Puppeteer] Launch check failed:', error)
		return {
			available: false,
			reason: buildReasonMessage(error),
			error,
		}
	}
}

export async function checkPuppeteerAvailability({ force = false } = {}) {
	if (Config.IS_TEST_ENV) {
		return { available: true, reason: null, skipped: true }
	}

	const now = Date.now()

	if (!force && cachedResult && now - lastCheckedAt < CHECK_INTERVAL_MS) {
		return cachedResult
	}

	if (!pendingCheck) {
		pendingCheck = runLaunchCheck()
	}

	const result = await pendingCheck
	cachedResult = result
	lastCheckedAt = Date.now()
	pendingCheck = null
	return result
}
