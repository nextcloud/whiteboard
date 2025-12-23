/**
 * SPDX-FileCopyrightText: 2024 Ferdinand Thiessen <opensource@fthiessen.de>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'fs'
import { test as setup } from '@playwright/test'
import { configureNextcloud, runOcc, runExec } from '@nextcloud/e2e-test-server'

type AppList = {
	enabled: Record<string, string>
	disabled: Record<string, string>
}

const getServerBranch = () => {
	if (process.env.SERVER_VERSION) {
		return process.env.SERVER_VERSION
	}

	try {
		const appinfo = readFileSync('appinfo/info.xml').toString()
		const maxVersion = appinfo.match(
			/<nextcloud min-version="\d+" max-version="(\d\d+)" \/>/,
		)?.[1]
		return maxVersion ? `stable${maxVersion}` : 'master'
	} catch {
		return 'master'
	}
}

const readAppList = async (): Promise<AppList> => {
	const raw = await runOcc(['app:list', '--output', 'json'])
	const jsonStart = raw.indexOf('{')
	if (jsonStart === -1) {
		throw new Error('Could not read app list from occ output')
	}
	return JSON.parse(raw.slice(jsonStart)) as AppList
}

const isAppEnabled = async (app: string) => {
	const list = await readAppList()
	return Boolean(list.enabled?.[app])
}

const enableAppIfPresent = async (app: string) => {
	const list = await readAppList()
	if (list.disabled?.[app]) {
		await runOcc(['app:enable', '--force', app])
	}
	return isAppEnabled(app)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const ensureAssistantInstalled = async () => {
	if (await isAppEnabled('assistant')) {
		return
	}

	if (await enableAppIfPresent('assistant')) {
		return
	}

	for (let attempt = 1; attempt <= 2; attempt++) {
		await runOcc(['app:install', '--force', 'assistant'])
		if (await isAppEnabled('assistant')) {
			return
		}
		await sleep(1000 * attempt)
	}

	const repo = 'https://github.com/nextcloud/assistant.git'
	const branch = getServerBranch()
	const branches = branch === 'master' ? ['master'] : [branch, 'master']

	for (const ref of branches) {
		await runExec(['git', 'clone', '--depth=1', `--branch=${ref}`, repo, 'apps/assistant'])
		await runOcc(['app:enable', '--force', 'assistant'])
		if (await isAppEnabled('assistant')) {
			return
		}
		await sleep(1000)
	}

	throw new Error('Assistant app could not be installed or enabled')
}

/**
 * We use this to ensure Nextcloud is configured correctly before running our tests
 *
 * This can not be done in the webserver startup process,
 * as that only checks for the URL to be accessible which happens already before everything is configured.
 */
setup('Configure Nextcloud', async () => {
	setup.slow()
	setup.setTimeout(5 * 60 * 1000)
	const appsToInstall = [
		'whiteboard',
		'viewer',
		'assistant',
		'testing',
	]
	await configureNextcloud(appsToInstall)
	await ensureAssistantInstalled()
	await runOcc(['app:disable', 'firstrunwizard'])
	await runOcc(['config:app:set', 'whiteboard', 'collabBackendUrl', '--value', 'http://localhost:3002'])
	await runOcc(['config:app:set', 'whiteboard', 'jwt_secret_key', '--value', 'secret'])
})
