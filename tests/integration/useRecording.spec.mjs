/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRecording } from '../../src/hooks/useRecording.ts'
import { useCollaborationStore } from '../../src/stores/useCollaborationStore.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket {
	connected = true
	listeners = new Map()
	emitted = []

	on(event, listener) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
		return this
	}

	off(event, listener) {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
		return this
	}

	emit(event) {
		this.emitted.push(event)
		return this
	}

	fire(event, ...args) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args)
		}
	}
}

describe('recording availability in useRecording', () => {
	let root
	let socket
	let recording

	function Board() {
		recording = useRecording({ fileId: 42 })
		return null
	}

	const answer = (payload) => act(async () => socket.fire('recording-availability', payload))
	const checks = () => socket.emitted.filter((event) => event === 'check-recording-availability').length

	beforeEach(async () => {
		socket = new FakeSocket()
		useCollaborationStore.setState({ socket, status: 'online' })
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
	})

	afterEach(async () => {
		await act(async () => root.unmount())
		useCollaborationStore.setState({ socket: null, status: 'offline' })
	})

	it('offers recording only after the server answered', async () => {
		expect(checks()).toBe(1)
		expect(recording.isEnabled).toBe(false)

		await answer({ available: true, reason: null })

		expect(recording.isEnabled).toBe(true)
		expect(recording.isAvailable).toBe(true)
	})

	it('turns recording off without a notice when the server has it turned off', async () => {
		await answer({ available: false, enabled: false, reason: null })

		expect(recording.isEnabled).toBe(false)
		expect(recording.showUnavailableInfo).toBe(false)
	})

	it('asks again after a reconnect and offers nothing until the answer', async () => {
		await answer({ available: true, reason: null })

		await act(async () => socket.fire('connect'))

		expect(checks()).toBe(2)
		expect(recording.isEnabled).toBe(false)
		expect(recording.isAvailable).toBeNull()

		await answer({ available: false, enabled: false, reason: null })
		expect(recording.isEnabled).toBe(false)
	})
})
