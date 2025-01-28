/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import puppeteer from 'puppeteer'
import fs from 'fs/promises'
import path from 'path'
import EventEmitter from 'events'
import fetch from 'node-fetch'
import FormData from 'form-data'
import https from 'https'

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

// Create HTTPS agent that ignores certificate errors (for development only)
const httpsAgent = new https.Agent({
	rejectUnauthorized: false,
})

export default class RecordingService extends EventEmitter {

	#status = new Map()
	#sessions = new Map()

	constructor(tokenGenerator, config = {}) {
		super()
		this.tokenGenerator = tokenGenerator
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

	async init(boardUrl, roomId, userId, maxRetries = 3) {
		const sessionKey = this.#getSessionKey(roomId, userId)

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			let browser
			try {
				await fs.mkdir(this.recordingsPath, { recursive: true })

				browser = await puppeteer.launch({
					headless: 'new',
					args: [
						...this.config.browserArgs,
						`--unsafely-treat-insecure-origin-as-secure=${boardUrl}`,
					],
					ignoreDefaultArgs: ['--mute-audio'],
					defaultViewport: this.config.viewport,
				})

				const page = await browser.newPage()
				await page.setJavaScriptEnabled(true)
				await page.setViewport({ ...this.config.viewport, isLandscape: true })

				// Consolidated event listeners
				page.on('console', msg =>
					console.log(`PAGE LOG [${sessionKey}]:`, msg.text()),
				)
				page.on('error', error =>
					this.#handleError(sessionKey, error, 'Page error'),
				)

				await this.#navigateWithRetry(page, boardUrl, sessionKey)
				await this.#waitForWhiteboardReady(page, sessionKey)
				await this.#initializeUserTracking(page, userId)

				this.#sessions.set(sessionKey, { browser, page, isRecording: false })
				this.#updateStatus(sessionKey, { isInitialized: true })

				this.emit('initialized', { boardUrl, roomId, userId })
				return true
			} catch (error) {
				await browser?.close()
				this.#handleRetryError(sessionKey, error, attempt, maxRetries)
			}
		}
		return false
	}

	async #navigateWithRetry(page, url, sessionKey) {
		try {
			console.log(`Navigating to board [${sessionKey}]:`, url)
			await page.goto(url, {
				waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
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
			() => document.querySelector('.excalidraw') && window.collab?.followUser,
			{ timeout: this.config.timeouts.navigation },
		)
		console.log(`Whiteboard loaded [${sessionKey}]`)
	}

	async #initializeUserTracking(page, userId) {
		await page.evaluate(userId => {
			window.collab.followUser(userId)
			console.log('Following user:', userId)
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

	#handleRetryError(sessionKey, error, attempt, maxRetries) {
		console.error(`Initialization attempt ${attempt} failed [${sessionKey}]:`, error)
		if (attempt === maxRetries) throw error
		return new Promise(resolve => setTimeout(resolve, 2000 * attempt))
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

			// Create Buffer from the array of numbers
			await fs.writeFile(outputPath, Buffer.from(buffer))

			let uploadedFileUrl = null

			// Upload the recording to Nextcloud
			try {
				const formData = new FormData()
				formData.append('recording', Buffer.from(buffer), {
					filename: 'recording.webm',
					contentType: 'video/webm',
				})

				const sharedToken = this.tokenGenerator.handle(roomId)
				const uploadUrl = `${process.env.NEXTCLOUD_URL}/index.php/apps/whiteboard/recording/${roomId}/${userId}/upload?token=${sharedToken}`
				console.log('uploadUrl', uploadUrl)

				const response = await fetch(uploadUrl.toString(), {
					method: 'POST',
					body: formData,
					headers: {
						...formData.getHeaders(),
						Accept: 'application/json',
					},
					agent: httpsAgent,
				})

				if (!response.ok) {
					throw new Error(`Upload failed: ${response.statusText}`)
				}

				const result = await response.json()
				console.log(`Recording uploaded successfully [${sessionKey}]:`, result)
				uploadedFileUrl = result.fileUrl // Get the file URL from the response
			} catch (error) {
				console.error(`Failed to upload recording [${sessionKey}]:`, error)
				// Don't throw here - we still want to update status and return the local path
			}

			// Update status
			const status = this.#status.get(sessionKey)
			status.isRecording = false
			this.#status.set(sessionKey, status)

			console.log(`Recording stopped for session [${sessionKey}]`)
			return {
				localPath: outputPath,
				fileUrl: uploadedFileUrl,
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
