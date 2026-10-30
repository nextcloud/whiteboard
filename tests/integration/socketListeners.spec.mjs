/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { addSocketListeners } from '../../src/utils/socketListeners.ts'

describe('addSocketListeners', () => {
	it('removes only its own listeners from a shared socket', () => {
		const socket = new EventEmitter()
		const collaborationConnect = vi.fn()
		socket.on('connect', collaborationConnect)
		const recordingConnect = vi.fn()

		const remove = addSocketListeners(socket, { connect: recordingConnect, 'recording-started': vi.fn() })
		remove()
		socket.emit('connect')

		expect(collaborationConnect).toHaveBeenCalledOnce()
		expect(recordingConnect).not.toHaveBeenCalled()
		expect(socket.listenerCount('recording-started')).toBe(0)
	})

	it('removes the listeners from the socket they were added to', () => {
		const oldSocket = new EventEmitter()
		const newSocket = new EventEmitter()
		const listener = vi.fn()

		const remove = addSocketListeners(oldSocket, { disconnect: listener })
		addSocketListeners(newSocket, { disconnect: listener })
		remove()

		expect(oldSocket.listenerCount('disconnect')).toBe(0)
		expect(newSocket.listenerCount('disconnect')).toBe(1)
	})
})
