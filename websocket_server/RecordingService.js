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
	videoBitrate: 2500000,
	timeouts: { navigation: 60000, page: 60000 },
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

export class RecordingService extends EventEmitter {

	#status = {
		isInitialized: false,
		isRecording: false,
		currentSession: null,
		errors: [],
	}

	constructor(config = {}) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.browser = null
		this.page = null
		this.recording = false
		this.recordingsPath = path.join(process.cwd(), 'recordings')
		this.currentSessionId = null
	}

	getStatus() {
		return { ...this.#status }
	}

	async init(boardUrl, maxRetries = 3) {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await fs.mkdir(this.recordingsPath, { recursive: true })

				this.browser = await puppeteer.launch({
					headless: true,
					args: [...this.config.browserArgs, `--unsafely-treat-insecure-origin-as-secure=${boardUrl}`],
					ignoreDefaultArgs: ['--mute-audio'],
					defaultViewport: this.config.viewport,
				})

				this.page = await this.browser.newPage()
				await this.page.setJavaScriptEnabled(true)
				await this.page.setViewport({
					...this.config.viewport,
					isLandscape: true,
				})

				// Enable console log from the page
				this.page.on('console', (msg) =>
					console.log('PAGE LOG:', msg.text()),
				)

				// Set longer timeouts and better wait conditions
				await this.page.setDefaultNavigationTimeout(this.config.timeouts.navigation) // 60 seconds timeout
				await this.page.setDefaultTimeout(this.config.timeouts.page)

				console.log('Navigating to board:', boardUrl)
				await this.page.goto(boardUrl, {
					waitUntil: ['networkidle0', 'domcontentloaded', 'load'], // Wait for all network activity and page load
					timeout: this.config.timeouts.navigation,
				})
				console.log('Page loaded')

				// Wait for whiteboard to be fully initialized
				await this.page.waitForFunction(
					() => {
						const canvas = document.querySelector('.excalidraw')
						const appLoaded = window.collab !== undefined
						return canvas && appLoaded
					},
					{ timeout: this.config.timeouts.navigation },
				)
				console.log('Whiteboard loaded')

				// Verify the page is loaded correctly
				const isWhiteboardLoaded = await this.page.evaluate(() => {
					const canvas = document.querySelector('.excalidraw')
					// console.log('Canvas found:', !!canvas)
					return !!canvas
				})

				if (!isWhiteboardLoaded) {
					throw new Error('Whiteboard not found after loading')
				}

				// Add stabilization delay
				await new Promise((resolve) => setTimeout(resolve, 500))
				console.log('Whiteboard stabilized after delay')

				this.#status.isInitialized = true
				this.emit('initialized', { boardUrl })
				return true
			} catch (error) {
				console.error(`Initialization attempt ${attempt} failed:`, error)
				this.#status.errors.push({ timestamp: Date.now(), error })
				this.emit('error', error)

				if (attempt === maxRetries) {
					throw error
				}
				await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
			}
		}
		return false
	}

	async followUser(userId) {
		if (!this.page) {
			throw new Error('Browser not initialized')
		}

		try {
			// Wait for collab to be available
			await this.page.waitForFunction(() => window.collab)

			// Follow user
			await this.page.evaluate((targetUserId) => {
				window.collab.followUser(targetUserId)
			}, userId)

			console.log('Following user:', userId)
			return true
		} catch (error) {
			console.error('Failed to follow user:', error)
			return false
		}
	}

	async startRecording(sessionId) {
		if (!this.page || this.recording) {
			return false
		}

		try {
			this.currentSessionId = sessionId
			this.recording = true
			const sessionPath = path.join(this.recordingsPath, sessionId)
			await fs.mkdir(sessionPath, { recursive: true })

			// Start browser-based recording
			await this.page.evaluate(() => {
				return new Promise((resolve, reject) => {
					// Request full screen capture
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
							videoBitsPerSecond: 2500000, // 2.5 Mbps
						})

						window.recordedChunks = []
						mediaRecorder.ondataavailable = (event) => {
							if (event.data.size > 0) {
								window.recordedChunks.push(event.data)
							}
						}

						// Store stream to stop it later
						window.recordingStream = stream

						mediaRecorder.start(1000) // Collect data every second
						window.mediaRecorder = mediaRecorder
						resolve()
					}).catch(err => {
						reject(new Error('Failed to get display media: ' + err))
					})
				})
			})

			console.log('Recording started for session:', sessionId)
			return true
		} catch (error) {
			console.error('Failed to start recording:', error)
			this.recording = false
			return false
		}
	}

	async stopRecording() {
		if (!this.page || !this.recording || !this.currentSessionId) {
			return false
		}

		try {
			this.recording = false
			const sessionPath = path.join(this.recordingsPath, this.currentSessionId)
			const outputPath = path.join(sessionPath, 'recording.webm')

			// Stop recording and get the array buffer directly
			const buffer = await this.page.evaluate(() => {
				return new Promise((resolve) => {
					const mediaRecorder = window.mediaRecorder
					mediaRecorder.onstop = () => {
						// Stop all tracks in the stream
						if (window.recordingStream) {
							window.recordingStream.getTracks().forEach(track => track.stop())
						}

						const blob = new Blob(window.recordedChunks, {
							type: 'video/webm',
						})
						const reader = new FileReader()
						reader.onload = () => {
							const array = new Uint8Array(reader.result)
							resolve(Array.from(array))
						}
						reader.readAsArrayBuffer(blob)
					}
					mediaRecorder.stop()
				})
			})

			// Write the file using the array of numbers
			await fs.writeFile(outputPath, Buffer.from(buffer))

			this.currentSessionId = null
			console.log('Recording stopped and saved to:', outputPath)
			return outputPath
		} catch (error) {
			console.error('Failed to stop recording:', error)
			return false
		}
	}

	async cleanup() {
		try {
			if (this.recording) {
				await this.stopRecording()
			}
			if (this.page) {
				await this.page.close()
			}
			if (this.browser) {
				await this.browser.close()
			}
		} catch (error) {
			this.#status.errors.push({ timestamp: Date.now(), error })
			this.emit('error', error)
		} finally {
			this.browser = null
			this.page = null
			this.recording = false
			this.#status.isInitialized = false
			this.emit('cleanup')
		}
	}

}
