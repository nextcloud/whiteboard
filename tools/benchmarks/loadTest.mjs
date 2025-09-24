#!/usr/bin/env node

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Synthetic load generator for the Whiteboard websocket server.
 * Creates multiple socket.io clients, joins a shared room, and simulates
 * cursor/viewport activity to approximate real collaboration traffic.
 */

import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'

const concurrency = parseInt(process.argv[2] || '1', 10)
const durationSeconds = parseInt(process.argv[3] || '45', 10)
const updateRate = parseFloat(process.argv[4] || '3') // cursor updates per second for active senders
const activeRatio = parseFloat(process.argv[5] || '0.3') // fraction of users broadcasting activity

if (!Number.isFinite(concurrency) || concurrency <= 0) {
	throw new Error('Invalid concurrency value')
}

const durationMs = durationSeconds * 1000
const serverUrl = process.env.LOAD_TEST_SERVER_URL || 'http://127.0.0.1:3002'
const sharedSecret = process.env.LOAD_TEST_JWT_SECRET || process.env.JWT_SECRET_KEY || 'benchmark-secret'
const roomId = process.env.LOAD_TEST_ROOM_ID || 'benchmark-room'
const activeSenders = Math.max(1, Math.round(concurrency * activeRatio))

const results = []

const nowSeconds = () => Math.floor(Date.now() / 1000)

function buildTokenPayload(index) {
	const issuedAt = nowSeconds()
	return {
		userid: `user-${index}`,
		fileId: 4242,
		isFileReadOnly: false,
		user: {
			id: `user-${index}`,
			name: `Load Tester ${index}`,
		},
		iat: issuedAt,
		exp: issuedAt + 6 * 60 * 60,
	}
}

function bytesForPayload(payload) {
	return Buffer.byteLength(JSON.stringify(payload))
}

function scheduleActiveTraffic(socket, metrics, index) {
	if (updateRate <= 0) {
		return { clear: () => {} }
	}

	const baseDelay = 500 + Math.random() * 500
	const moveIntervalMs = Math.max(200, Math.floor(1000 / updateRate))

	const encoder = (payload) => Buffer.from(JSON.stringify(payload))

	let cursorHandler = null
	let viewportHandler = null
	const startTimer = setTimeout(() => {
		cursorHandler = setInterval(() => {
			const payload = {
				type: 'MOUSE_LOCATION',
				payload: {
					pointer: {
						x: Math.random() * 2500,
						y: Math.random() * 1400,
						pointerId: `pointer-${index}`,
					},
					buttons: Math.random() > 0.8 ? 1 : 0,
					user: {
						id: `user-${index}`,
						name: `Load Tester ${index}`,
					},
				},
			}
			const buffer = encoder(payload)
			socket.emit('server-volatile-broadcast', roomId, buffer)
			metrics.bytesSent += buffer.byteLength
			metrics.messagesSent += 1
		}, moveIntervalMs)

		viewportHandler = setInterval(() => {
			const payload = {
				type: 'VIEWPORT_UPDATE',
				payload: {
					offsetX: Math.random() * 1500,
					offsetY: Math.random() * 900,
					zoom: 0.5 + Math.random() * 0.5,
					scale: 1,
					userId: `user-${index}`,
				},
			}
			const buffer = encoder(payload)
			socket.emit('server-volatile-broadcast', roomId, buffer)
			metrics.bytesSent += buffer.byteLength
			metrics.messagesSent += 1
		}, 1000)
	}, baseDelay)

	return {
		clear: () => {
			clearTimeout(startTimer)
			if (cursorHandler) {
				clearInterval(cursorHandler)
			}
			if (viewportHandler) {
				clearInterval(viewportHandler)
			}
		},
	}
}

function createClient(index) {
	return new Promise((resolve) => {
		const isActiveSender = index < activeSenders
		const metrics = {
			index,
			isActiveSender,
			bytesSent: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,
			joinDelayMs: null,
			completed: false,
			dropped: false,
		}

		const token = jwt.sign(buildTokenPayload(index), sharedSecret)
		const socket = io(serverUrl, {
			forceNew: true,
			reconnection: false,
			transports: ['websocket'],
			auth: { token },
			timeout: 10000,
			extraHeaders: {
				Origin: process.env.LOAD_TEST_ORIGIN || 'http://localhost',
			},
		})

		let stopped = false
		let startTime = Date.now()
		let trafficHandle = null

		const stop = (reason) => {
			if (stopped) {
				return
			}
			stopped = true
			metrics.stopReason = reason
			metrics.durationMs = Date.now() - startTime
			if (trafficHandle) {
				trafficHandle.clear()
			}
			if (socket.connected) {
				socket.disconnect()
			}
			resolve(metrics)
		}

	socket.on('connect_error', (error) => {
		metrics.error = error.message
		metrics.dropped = true
		console.error(`[client ${index}] connect_error`, error)
		stop('connect_error')
	})

		socket.on('disconnect', () => {
			if (!metrics.completed) {
				metrics.dropped = true
				stop('disconnect')
			}
		})

		socket.on('init-room', () => {
			socket.emit('join-room', roomId)
		})

		socket.on('sync-designate', () => {
			if (metrics.joinDelayMs !== null) {
				return
			}

			metrics.joinDelayMs = Date.now() - startTime

			if (isActiveSender) {
				trafficHandle = scheduleActiveTraffic(socket, metrics, index)
			}
		})

		const recordPayload = (payload) => {
			const size = bytesForPayload(payload)
			metrics.bytesReceived += size
			metrics.messagesReceived += 1
		}

		socket.on('room-user-change', recordPayload)
		socket.on('user-joined', recordPayload)
		socket.on('user-left', recordPayload)

		socket.on('client-broadcast', (data) => {
			let size = 0
			if (data instanceof ArrayBuffer) {
				size = data.byteLength
			} else if (ArrayBuffer.isView(data)) {
				size = data.byteLength
			} else if (typeof data === 'string') {
				size = Buffer.byteLength(data)
			} else if (data) {
				size = bytesForPayload(data)
			}
			metrics.bytesReceived += size
			metrics.messagesReceived += 1
		})

		setTimeout(() => {
			metrics.completed = true
			stop('completed')
		}, durationMs + 1000)
	})
}

const clientPromises = []
for (let i = 0; i < concurrency; i += 1) {
	clientPromises.push(createClient(i))
}

const clientResults = await Promise.all(clientPromises)

clientResults.forEach((metrics) => results.push(metrics))

const totals = clientResults.reduce((acc, metrics) => {
	acc.bytesSent += metrics.bytesSent
	acc.bytesReceived += metrics.bytesReceived
	acc.messagesSent += metrics.messagesSent
	acc.messagesReceived += metrics.messagesReceived
	if (metrics.joinDelayMs !== null) {
		acc.joinDelays.push(metrics.joinDelayMs)
	}
	if (metrics.dropped) {
		acc.dropped += 1
	}
	return acc
}, {
	bytesSent: 0,
	bytesReceived: 0,
	messagesSent: 0,
	messagesReceived: 0,
	joinDelays: [],
	dropped: 0,
})

const averageJoinDelay = totals.joinDelays.length > 0
	? totals.joinDelays.reduce((sum, value) => sum + value, 0) / totals.joinDelays.length
	: null

const summary = {
	serverUrl,
	roomId,
	concurrency,
	activeSenders,
	activeRatio,
	durationSeconds,
	updateRate,
	bytesSent: totals.bytesSent,
	bytesReceived: totals.bytesReceived,
	messagesSent: totals.messagesSent,
	messagesReceived: totals.messagesReceived,
	averageJoinDelayMs: averageJoinDelay,
	droppedConnections: totals.dropped,
}

console.log(JSON.stringify(summary, null, 2))
