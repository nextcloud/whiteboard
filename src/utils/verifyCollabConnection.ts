/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client'

import { io } from 'socket.io-client'

export type CollabConnectionResult = {
	verified: boolean
	error?: string
	cancelled?: boolean
}

export type CollabConnectionCheck = {
	result: Promise<CollabConnectionResult>
	cancel: () => void
}

type Connect = (uri: string, options: Partial<ManagerOptions & SocketOptions>) => Socket

// The collaboration server answers a valid secret without a board token with this error
const VERIFIED = 'Connection verified'
const RECONNECTION_ATTEMPTS = 2
// Three attempts with socket.io's default timeout of 20 seconds, and their reconnection delays
const DEADLINE_MS = 75_000

/**
 * Check from the browser that the collaboration server is reachable and
 * accepts the shared secret. Like the editor, it waits for a slow server and
 * retries before it reports a failure.
 *
 * @param serverUrl - URL of the collaboration server
 * @param secret - Token signed with the shared secret
 * @param connect - Opens the socket
 */
export function verifyCollabConnection(serverUrl: string, secret: string, connect: Connect = io): CollabConnectionCheck {
	let socket: Socket | null = null
	let settle: (result: CollabConnectionResult) => void = () => {}
	let lastError = 'timeout'
	const deadline = setTimeout(() => settle({ verified: false, error: lastError }), DEADLINE_MS)

	const result = new Promise<CollabConnectionResult>((resolve) => {
		settle = (outcome) => {
			settle = () => {}
			clearTimeout(deadline)
			if (socket) {
				socket.io.off('reconnect_failed')
				socket.off()
				socket.close()
				socket = null
			}
			resolve(outcome)
		}
	})
	const check = { result, cancel: () => settle({ verified: false, cancelled: true }) }

	let url: URL
	try {
		url = new URL(serverUrl)
	} catch (error) {
		settle({ verified: false, error: (error as Error).message })
		return check
	}

	socket = connect(url.origin, {
		path: url.pathname.replace(/\/$/, '') + '/socket.io',
		withCredentials: true,
		auth: { secret },
		transports: ['websocket'],
		reconnectionAttempts: RECONNECTION_ATTEMPTS,
	})
	socket.on('connect', () => settle({ verified: true }))
	socket.on('connect_error', (error: Error) => {
		if (error.message === VERIFIED) {
			settle({ verified: true })
			return
		}
		lastError = error.message
		// Socket.io retries network errors by itself and only gives up on an answer of the server
		if (!socket?.active) {
			settle({ verified: false, error: lastError })
		}
	})
	socket.io.on('reconnect_failed', () => settle({ verified: false, error: lastError }))

	return check
}
