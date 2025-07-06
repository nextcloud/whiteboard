/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import puppeteer from 'puppeteer'
import fs from 'fs/promises'
import path from 'path'
import EventEmitter from 'events'

const DEFAULT_CONFIG = {
	viewport: { width: 1920, height: 1080 },
	frameRate: 30,
	videoBitrate: 2_500_000,
	timeouts: { navigation: 60_000, page: 60_000 },
	browserArgs: [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--allow-display-capture',
		'--auto-select-desktop-capture-source="Chromium"',
		'--disable-web-security',
		'--disable-features=IsolateOrigins,site-per-process',
		'--allow-file-access-from-files',
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		'--enable-usermedia-screen-capturing',
		'--autoplay-policy=no-user-gesture-required',
	],
}

export default class RecordingService extends EventEmitter {

	#status = new Map()
	#sessions = new Map()

	constructor(config = {}) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.recordingsPath = path.join(process.cwd(), 'recordings')
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
			await fs.mkdir(this.recordingsPath, { recursive: true })

			browser = await puppeteer.launch({
				headless: 'new',
				args: [
					...this.config.browserArgs,
					`--unsafely-treat-insecure-origin-as-secure=${new URL(recordingUrl).origin}`,
				],
				ignoreDefaultArgs: ['--mute-audio'],
				defaultViewport: this.config.viewport,
			})

			const page = await browser.newPage()
			await page.setJavaScriptEnabled(true)
			await page.setViewport({ ...this.config.viewport, isLandscape: true })

			// Set a proper user-agent to avoid being treated as a bot
			await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

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

			this.#sessions.set(sessionKey, { browser, page, isRecording: false })
			this.#updateStatus(sessionKey, { isInitialized: true })

			this.emit('initialized', { recordingUrl, roomId, userId })
			return true
		} catch (error) {
			console.error(`[${sessionKey}] Initialization failed:`, error)
			await browser?.close()
			throw error
		}
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
			throw new Error(`Page load failed: ${error.message}`)
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
			await fs.mkdir(sessionPath, { recursive: true })

			// Start browser-based recording
			await page.evaluate(() => {
				return new Promise((resolve, reject) => {
					navigator.mediaDevices.getDisplayMedia({
						video: {
							displaySurface: 'browser',
							width: { ideal: 1920 },
							height: { ideal: 1080 },
							frameRate: { ideal: 30 },
						},
					}).then(stream => {
						const mediaRecorder = new MediaRecorder(stream, {
							mimeType: 'video/webm;codecs=vp9',
							videoBitsPerSecond: 2500000,
						})

						window.recordedChunks = []
						mediaRecorder.ondataavailable = (event) => {
							if (event.data.size > 0) {
								window.recordedChunks.push(event.data)
							}
						}

						window.recordingStream = stream
						mediaRecorder.start(1000)
						window.mediaRecorder = mediaRecorder
						resolve()
					}).catch(err => {
						reject(new Error('Failed to get display media: ' + err))
					})
				})
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
			const { page } = session
			session.isRecording = false
			const sessionPath = path.join(this.recordingsPath, sessionKey)
			const formattedDate = new Date().toISOString().slice(0, 16).replace('T', ' ')
			const outputPath = path.join(sessionPath, `${formattedDate}.webm`)

			// Stop recording and get the array buffer
			const buffer = await page.evaluate(() => {
				return new Promise((resolve) => {
					const mediaRecorder = window.mediaRecorder
					mediaRecorder.onstop = () => {
						const blob = new Blob(window.recordedChunks, { type: 'video/webm' })
						const reader = new FileReader()
						reader.onloadend = () => {
							// Convert ArrayBuffer to Uint8Array for proper serialization
							const array = new Uint8Array(reader.result)
							resolve(Array.from(array))
						}
						reader.readAsArrayBuffer(blob)
						window.recordingStream.getTracks().forEach(track => track.stop())
					}
					mediaRecorder.stop()
				})
			})

			// Create Buffer from the array of numbers and save locally
			await fs.writeFile(outputPath, Buffer.from(buffer))

			// Update status
			const status = this.#status.get(sessionKey)
			status.isRecording = false
			this.#status.set(sessionKey, status)

			console.log(`Recording stopped for session [${sessionKey}]`)
			return {
				localPath: outputPath,
				recordingData: buffer, // Return raw recording data for client upload
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
			this.#sessions.delete(sessionKey)
			this.#status.delete(sessionKey)
		}
	}

}
