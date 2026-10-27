/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfigMock } from './configMock.js'

const browsers = vi.hoisted(() => [])

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({ RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'whiteboard-recordings-')) }),
}))

vi.mock('puppeteer-core', () => ({
	launch: vi.fn(async () => {
		const calls = []
		const page = {
			calls,
			on: () => {},
			setCacheEnabled: async () => {},
			setExtraHTTPHeaders: async () => {},
			setRequestInterception: async () => {},
			setJavaScriptEnabled: async () => {},
			setViewport: async () => {},
			setUserAgent: async () => {},
			goto: async () => {},
			waitForFunction: async () => {},
			addStyleTag: async () => {},
			evaluate: vi.fn(async (fn, ...args) => {
				calls.push(['evaluate', fn.toString(), ...args])
			}),
			screencast: vi.fn(async () => {
				calls.push(['screencast'])
				return {
					stop: vi.fn(async () => {
						calls.push(['stop'])
					}),
				}
			}),
		}
		const browser = new EventEmitter()
		browser.page = page
		browser.newPage = async () => page
		browser.close = vi.fn(async () => browser.emit('disconnected'))
		browsers.push(browser)
		return browser
	}),
}))

const { default: RecordingService } = await import('../../websocket_server/Services/RecordingService.js')

async function startedRecorder() {
	const recorder = new RecordingService()
	await recorder.init('https://cloud.example/apps/whiteboard/recording/42/teacher?token=t', '42', 'teacher')
	await recorder.startRecording('42', 'teacher')
	return { recorder, page: browsers.at(-1).page, browser: browsers.at(-1) }
}

describe('RecordingService', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('keeps the page repainting before the screencast starts', async () => {
		const { page } = await startedRecorder()

		const repaint = page.calls.findIndex(([name, fn]) => name === 'evaluate' && fn.includes('setInterval'))
		const screencast = page.calls.findIndex(([name]) => name === 'screencast')
		expect(repaint).toBeGreaterThanOrEqual(0)
		expect(repaint).toBeLessThan(screencast)
	})

	it('keeps capturing for two seconds after the stop request', async () => {
		vi.useFakeTimers()
		const { recorder, page } = await startedRecorder()

		const stopping = recorder.stopRecording('42', 'teacher')
		await vi.advanceTimersByTimeAsync(1999)
		expect(page.calls.some(([name]) => name === 'stop')).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(page.calls.some(([name]) => name === 'stop')).toBe(true)
		vi.useRealTimers()
		await stopping
	})
})
