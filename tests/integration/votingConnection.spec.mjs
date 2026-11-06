/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const showError = vi.hoisted(() => vi.fn())

vi.mock('@nextcloud/dialogs', () => ({ showError }))
vi.mock('@nextcloud/auth', () => ({ getCurrentUser: () => ({ uid: 'alice' }) }))

const { useVoting } = await import('../../src/hooks/useVoting.ts')
const { useCollaborationStore } = await import('../../src/stores/useCollaborationStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('voting', () => {
	let voting
	let socket

	function Board() {
		voting = useVoting()
		return null
	}

	async function render(status, connected) {
		socket = { connected, emit: vi.fn(), on: vi.fn(), off: vi.fn() }
		useCollaborationStore.setState({ status, socket })
		await act(async () => createRoot(document.createElement('div')).render(createElement(Board)))
	}

	beforeEach(() => {
		showError.mockClear()
		useWhiteboardConfigStore.setState({ fileId: 1 })
	})

	it('tells the user when the collaboration server is not connected', async () => {
		await render('offline', false)

		expect(voting.startVoting('Lunch?', 'single-choice', ['Pizza', 'Sushi'])).toBe(false)
		expect(socket.emit).not.toHaveBeenCalled()
		expect(showError).toHaveBeenCalledWith('Voting requires connection to collaboration server')
	})

	it('starts the voting through the collaboration server', async () => {
		await render('online', true)

		expect(voting.startVoting('Lunch?', 'single-choice', ['Pizza', 'Sushi'])).toBe(true)
		expect(socket.emit).toHaveBeenCalledWith('voting-start', '1', { question: 'Lunch?', type: 'single-choice', options: ['Pizza', 'Sushi'] })
		expect(showError).not.toHaveBeenCalled()
	})

	it('uses the connection at the time of submitting, not when the dialog opened', async () => {
		await render('offline', false)
		const startFromDialog = voting.startVoting
		const online = { connected: true, emit: vi.fn(), on: vi.fn(), off: vi.fn() }
		useCollaborationStore.setState({ status: 'online', socket: online })

		expect(startFromDialog('Lunch?', 'single-choice', ['Pizza', 'Sushi'])).toBe(true)
		expect(online.emit).toHaveBeenCalledOnce()

		useCollaborationStore.setState({ status: 'offline', socket: null })

		expect(startFromDialog('Lunch?', 'single-choice', ['Pizza', 'Sushi'])).toBe(false)
		expect(showError).toHaveBeenCalledOnce()
	})
})
