/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { launch as launchChromium } from 'puppeteer-core'
import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import os from 'os'
import path from 'path'
import EventEmitter from 'events'
import Config from '../Utilities/ConfigUtility.js'

const DEFAULT_CONFIG = {
	viewport: { width: 1920, height: 1080 },
	frameRate: 30,
	videoBitrate: 2_500_000,
	timeouts: { navigation: 60_000, page: 60_000 },
	browserArgs: [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--disable-dev-shm-usage',
		'--disable-crashpad',
		'--disable-breakpad',
		'--enable-crashpad=0',
		'--allow-display-capture',
		'--auto-select-desktop-capture-source="Chromium"',
		'--disable-web-security',
		'--disable-features=IsolateOrigins,site-per-process',
		'--allow-file-access-from-files',
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		'--enable-usermedia-screen-capturing',
		'--autoplay-policy=no-user-gesture-required',
		'--ignore-certificate-errors',
		'--allow-insecure-localhost',
	],
}

export default class RecordingService extends EventEmitter {

	#status = new Map()
	#sessions = new Map()
	#recordingsPathPromise = null
	#recordingsRootLogReported = false

	constructor(config = {}) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.configuredRecordingsPath = Config.RECORDINGS_DIR ? path.resolve(Config.RECORDINGS_DIR) : null
		this.fallbackRecordingsPath = path.join(os.tmpdir(), 'whiteboard-recordings')
		this.recordingsPath = null
		this.profileRootPath = null
	}

	getStatus(roomId, userId) {
		const sessionKey = this.#getSessionKey(roomId, userId)
		return this.#status.get(sessionKey) || {
			isInitialized: false,
			isRecording: false,
			currentSession: null,
			errors: [],
		}
	}

	#getSessionKey(roomId, userId) {
		return `${roomId}_${userId}`
	}

	#parseSessionKey(sessionKey) {
		const [roomId, userId] = sessionKey.split('_')
		return { roomId, userId }
	}

	async init(recordingUrl, roomId, userId) {
		const sessionKey = this.#getSessionKey(roomId, userId)
		let browser

		try {
			const recordingOrigin = new URL(recordingUrl).origin
			const cacheBustToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
			const { profilePath, runtimeDir, crashpadDir } = await this.#prepareSessionProfile(sessionKey)

			// Use Config-based Chrome detection
			browser = await launchChromium({
				headless: 'new',
				executablePath: Config.CHROME_EXECUTABLE_PATH,
				args: [
					...this.config.browserArgs,
					`--crash-dumps-dir=${crashpadDir}`,
				],
				ignoreDefaultArgs: ['--mute-audio'],
				defaultViewport: this.config.viewport,
				userDataDir: profilePath,
				env: {
					...process.env,
					XDG_RUNTIME_DIR: runtimeDir,
				},
			})

			const page = await browser.newPage()
			await page.setCacheEnabled(false)
			await page.setExtraHTTPHeaders({
				'Cache-Control': 'no-cache, no-store, must-revalidate',
				Pragma: 'no-cache',
			})
			await page.setRequestInterception(true)
			page.on('request', request => {
				try {
					const resourceType = request.resourceType()
					if (resourceType === 'script' || resourceType === 'stylesheet') {
						const url = new URL(request.url())
						if (url.origin === recordingOrigin && !url.searchParams.has('cb')) {
							url.searchParams.set('cb', cacheBustToken)
							request.continue({ url: url.toString() })
							return
						}
					}
				} catch {
					// Fall through to default continue
				}
				request.continue()
			})
			await page.setJavaScriptEnabled(true)
			await page.setViewport({ ...this.config.viewport, isLandscape: true })

			// Set a proper user-agent to avoid being treated as a bot
			await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WhiteboardRecording/1.0')

			// Consolidated event listeners
			page.on('console', msg =>
				console.log(`PAGE LOG [${sessionKey}]:`, msg.text()),
			)
			page.on('error', error =>
				this.#handleError(sessionKey, error, 'Page error'),
			)

			await this.#navigateWithRetry(page, recordingUrl, sessionKey)
			await this.#waitForWhiteboardReady(page, sessionKey)
			await this.#initializeUserTracking(page, userId)

			this.#sessions.set(sessionKey, { browser, page, isRecording: false, profilePath })
			this.#updateStatus(sessionKey, { isInitialized: true })

			this.emit('initialized', { recordingUrl, roomId, userId })
			return true
		} catch (error) {
			console.error(`[${sessionKey}] Initialization failed:`, error)
			await browser?.close()
			throw error
		}
	}

	async #ensureRecordingEnvironment(sessionKey) {
		if (this.recordingsPath) {
			if (!this.profileRootPath) {
				this.profileRootPath = path.join(this.recordingsPath, '.chromium-profiles')
			}
			return
		}

		if (!this.#recordingsPathPromise) {
			this.#recordingsPathPromise = this.#resolveRecordingsPath(sessionKey)
		}

		let resolvedPath
		try {
			resolvedPath = await this.#recordingsPathPromise
		} catch (error) {
			this.#recordingsPathPromise = null
			throw error
		}

		this.recordingsPath = resolvedPath
		this.profileRootPath = path.join(this.recordingsPath, '.chromium-profiles')
	}

	async #prepareSessionProfile(sessionKey) {
		await this.#ensureRecordingEnvironment(sessionKey)

		const profilePath = path.join(this.profileRootPath, sessionKey)
		const runtimeDir = path.join(profilePath, 'runtime')
		const crashpadDir = path.join(profilePath, 'crashpad')

		await Promise.all([
			fs.mkdir(profilePath, { recursive: true }),
			fs.mkdir(runtimeDir, { recursive: true }),
			fs.mkdir(crashpadDir, { recursive: true }),
		])

		return { profilePath, runtimeDir, crashpadDir }
	}

	async #resolveRecordingsPath(sessionKey) {
		const tried = []
		const candidates = [this.configuredRecordingsPath, this.fallbackRecordingsPath]

		for (const candidate of candidates) {
			if (!candidate) {
				continue
			}
			const normalized = path.resolve(candidate)
			if (tried.includes(normalized)) {
				continue
			}
			tried.push(normalized)

			try {
				await fs.mkdir(normalized, { recursive: true })
				const stats = await fs.stat(normalized)
				if (!stats.isDirectory()) {
					throw new Error('Path exists but is not a directory')
				}
				await fs.access(normalized, fsConstants.W_OK)

				if (!this.#recordingsRootLogReported) {
					const source = normalized === this.fallbackRecordingsPath ? 'fallback' : 'configured'
					console.log(`[Recording] Using ${source} recordings directory: ${normalized}`)
					if (source === 'fallback' && this.configuredRecordingsPath !== normalized) {
						console.warn('[Recording] Falling back to writable temporary directory. Set RECORDINGS_DIR to control the location explicitly.')
					}
					this.#recordingsRootLogReported = true
				}

				return normalized
			} catch (error) {
				const code = error?.code
				if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
					console.warn(`[${sessionKey}] Recording path '${normalized}' is not writable (${code}).`)
					continue
				}
				console.error(`[${sessionKey}] Failed to prepare recordings path '${normalized}':`, error)
			}
		}

		throw new Error(`No writable recordings directory available. Tried: ${tried.join(', ')}`)
	}

	async #navigateWithRetry(page, url, sessionKey) {
		try {
			console.log(`Navigating to board [${sessionKey}]:`, url)
			await page.goto(url, {
				waitUntil: ['domcontentloaded', 'load'],
				timeout: this.config.timeouts.navigation,
			})
			console.log(`Page loaded successfully [${sessionKey}]`)
		} catch (error) {
			console.error(`Failed to load page [${sessionKey}]:`, error)
			const reason = error?.message || String(error)
			if (reason.includes('ERR_CONNECTION_REFUSED')) {
				throw new Error('Page load failed: Unable to reach the Nextcloud URL from the recording container. Make sure the hostname resolves inside the container or adjust NEXTCLOUD_URL.')
			}
			throw new Error(`Page load failed: ${reason}`)
		}
	}

	async #waitForWhiteboardReady(page, sessionKey) {
		await page.waitForFunction(
			() => document.querySelector('.excalidraw') && window.followUser,
			{ timeout: this.config.timeouts.navigation },
		)
		console.log(`Whiteboard loaded [${sessionKey}]`)
	}

	async #initializeUserTracking(page, userId) {
		await page.evaluate(userId => {
			// Add debugging to see if the recording agent is receiving messages
			console.log('Recording agent initializing user tracking for:', userId)

			// Wait a bit for the websocket to connect
			setTimeout(() => {
				if (window.followUser) {
					window.followUser(userId)
					console.log('Recording agent now following user:', userId)

					// Test if we can manually trigger viewport following
					window.testViewportFollow = () => {
						console.log('Testing viewport follow functionality...')
						const testPayload = {
							userId,
							scrollX: 100,
							scrollY: 100,
							zoom: 1.5,
						}
						console.log('Simulating viewport update:', testPayload)
						// This should trigger the viewport update logic
						if (window.useCollaborationStore) {
							const store = window.useCollaborationStore.getState()
							console.log('Collaboration store state:', {
								followedUserId: store.followedUserId,
								status: store.status,
							})
						}
					}

					// Make test function available
					window.testViewportFollow()
				} else {
					console.error('Recording agent: window.followUser not available')
				}
			}, 2000) // Wait 2 seconds for websocket connection
		}, userId)
	}

	#updateStatus(sessionKey, updates) {
		const status = this.#status.get(sessionKey) || { errors: [] }
		this.#status.set(sessionKey, { ...status, ...updates })
	}

	#handleError(sessionKey, error, context) {
		console.error(`[${sessionKey}] ${context}:`, error)
		const status = this.#status.get(sessionKey) || { errors: [] }
		status.errors.push({ timestamp: Date.now(), error })
		this.#status.set(sessionKey, status)
		this.emit('error', {
			error,
			...this.#parseSessionKey(sessionKey),
		})
	}

	async startRecording(roomId, userId) {
		const sessionKey = this.#getSessionKey(roomId, userId)
		const session = this.#sessions.get(sessionKey)

		if (!session || session.isRecording) {
			return false
		}

		try {
			const { page } = session
			session.isRecording = true
			const sessionPath = path.join(this.recordingsPath, sessionKey)
			session.sessionPath = sessionPath
			session.lastRecordingPath = null

			await fs.mkdir(sessionPath, { recursive: true })
			const formattedDate = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
			const outputPath = path.join(sessionPath, `${formattedDate}.webm`)

			// Start browser-based recording
			page.screencast({ path: outputPath, ffmpegPath: '/usr/bin/ffmpeg' }).then(mediaRecorder => {
				session.mediaRecorder = mediaRecorder
			})

			// Update status
			const status = this.#status.get(sessionKey)
			status.isRecording = true
			this.#status.set(sessionKey, status)

			console.log(`Recording started for session [${sessionKey}]`)
			return true
		} catch (error) {
			console.error(`Failed to start recording [${sessionKey}]:`, error)
			session.isRecording = false
			return false
		}
	}

	async stopRecording(roomId, userId) {
		const sessionKey = this.#getSessionKey(roomId, userId)
		const session = this.#sessions.get(sessionKey)

		if (!session || !session.isRecording) {
			return false
		}

		try {
			session.isRecording = false
			const sessionPath = session.sessionPath || path.join(this.recordingsPath, sessionKey)
			const formattedDate = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
			const outputPath = path.join(sessionPath, `${formattedDate}.webm`)
			session.lastRecordingPath = outputPath

			// Stop recording and get the array buffer
			await session.mediaRecorder.stop()

			// Read the file into a buffer
			const recordingData = await fs.readFile(outputPath)

			// Update status
			const status = this.#status.get(sessionKey)
			status.isRecording = false
			this.#status.set(sessionKey, status)

			console.log(`Recording stopped for session [${sessionKey}]`)
			return {
				localPath: outputPath,
				recordingData, // Return raw recording data for client upload
			}
		} catch (error) {
			console.error(`Failed to stop recording [${sessionKey}]:`, error)
			return false
		}
	}

	async cleanup(roomId, userId) {
		const sessionKey = this.#getSessionKey(roomId, userId)
		const session = this.#sessions.get(sessionKey)

		if (session) {
			const { browser } = session
			if (browser) {
				await browser.close()
			}
			if (Config.CLEANUP_LOCAL_RECORDINGS) {
				const targets = [session.lastRecordingPath]
				for (const target of targets) {
					if (!target) {
						continue
					}
					try {
						await fs.rm(target, { force: true })
						console.log(`[Recording] Removed local recording file: ${target}`)
					} catch (error) {
						console.warn(`[Recording] Failed to remove recording file '${target}':`, error)
					}
				}

				const sessionDir = session.sessionPath || path.join(this.recordingsPath, sessionKey)
				try {
					await fs.rm(sessionDir, { recursive: true, force: true })
					console.log(`[Recording] Removed session directory: ${sessionDir}`)
				} catch (error) {
					console.warn(`[Recording] Failed to remove session directory '${sessionDir}':`, error)
				}
				if (session.profilePath) {
					try {
						await fs.rm(session.profilePath, { recursive: true, force: true })
						console.log(`[Recording] Removed session profile: ${session.profilePath}`)
					} catch (error) {
						console.warn(`[Recording] Failed to remove session profile '${session.profilePath}':`, error)
					}
				}
			}
			this.#sessions.delete(sessionKey)
			this.#status.delete(sessionKey)
		}
	}

}
