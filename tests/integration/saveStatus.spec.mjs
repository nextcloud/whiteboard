/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { SaveStatusIndicator } = await import('../../src/components/SaveStatusIndicator.tsx')
const { BoardUnavailable } = await import('../../src/components/BoardUnavailable.tsx')
const { NetworkStatusIndicator } = await import('../../src/components/NetworkStatusIndicator.tsx')
const { useBoardStatusStore } = await import('../../src/stores/useBoardStatusStore.ts')
const { useWhiteboardConfigStore } = await import('../../src/stores/useWhiteboardConfigStore.ts')
const { useCollaborationStore } = await import('../../src/stores/useCollaborationStore.ts')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const status = (change = {}) => ({ unavailable: false, unsavedSince: null, saving: false, failed: false, reason: null, savedAt: null, ...change })

describe('save state shown on the board', () => {
	let root
	let container

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date('2026-11-08T14:00:00') })
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
		useWhiteboardConfigStore.setState({ fileId: 7, isReadOnly: false, isVersionPreview: false, collabBackendUrl: 'https://collab.example' })
	})

	afterEach(async () => {
		await act(async () => root.unmount())
		container.remove()
		useBoardStatusStore.setState({ fileId: null, status: null })
		vi.useRealTimers()
	})

	async function show(component, boardStatus) {
		useBoardStatusStore.setState({ fileId: 7, status: boardStatus })
		await act(async () => root.render(createElement(component)))
	}

	it('says the board is saved', async () => {
		await show(SaveStatusIndicator, status({ savedAt: Date.now() }))

		expect(container.textContent).toContain('Saved')
		expect(container.querySelector('[role="status"]').getAttribute('aria-label')).toMatch(/Saved/)
		// Not taken for the collaboration indicator, which pages and tests look for
		expect(container.querySelector('.network-status')).toBeNull()
	})

	it('says it is saving while a save is on its way or due', async () => {
		await show(SaveStatusIndicator, status({ unsavedSince: Date.now() - 5_000 }))

		expect(container.textContent).toContain('Saving')
	})

	it('says since when changes are not saved when a save failed or none got through for a minute', async () => {
		const since = new Date('2026-11-08T13:58:00').getTime()
		await show(SaveStatusIndicator, status({ unsavedSince: since, failed: true }))
		expect(container.textContent).toMatch(/Not saved since .*1:58/)

		await act(async () => useBoardStatusStore.setState({ status: status({ unsavedSince: Date.now() - 30_000 }) }))
		expect(container.textContent).toContain('Saving')
		await act(async () => vi.advanceTimersByTimeAsync(35_000))
		expect(container.textContent).toContain('Not saved since')
	})

	it.each([
		['unauthorized', /log in again/i],
		['forbidden', /no longer edit/i],
		['gone', /deleted files/i],
		['tooLarge', /large images/i],
		['upgrade', /reload/i],
	])('says why a save did not reach Nextcloud (%s) and what to do', async (reason, action) => {
		const since = new Date('2026-11-08T13:58:00').getTime()
		await show(SaveStatusIndicator, status({ unsavedSince: since, failed: true, reason }))

		const indicator = container.querySelector('[role="status"]')
		expect(container.textContent).toMatch(/Not saved since .*1:58/)
		expect(indicator.getAttribute('title')).toMatch(/not saved/i)
		expect(indicator.getAttribute('title')).toMatch(action)
		expect(indicator.getAttribute('title')).not.toMatch(/can be reached/)
	})

	it('shows nothing in a tab that cannot save', async () => {
		useWhiteboardConfigStore.setState({ isReadOnly: true })
		await show(SaveStatusIndicator, status({ savedAt: Date.now() }))

		expect(container.textContent).toBe('')
	})

	it('covers a board that could not be loaded', async () => {
		await show(BoardUnavailable, status({ unavailable: true }))

		expect(container.textContent).toContain('could not be loaded')
	})

	it('does not cover a board that is loaded', async () => {
		await show(BoardUnavailable, status())

		expect(container.textContent).toBe('')
	})

	it('does not tell people their changes stay on the device when live collaboration is down', async () => {
		useCollaborationStore.setState({ status: 'offline' })
		await show(NetworkStatusIndicator, status())

		const label = container.querySelector('[role="button"]').getAttribute('title')
		expect(label).not.toMatch(/saved locally/i)
		expect(label).toMatch(/still saved/i)
	})

	it('shows no collaboration state when no collaboration server is set up', async () => {
		useWhiteboardConfigStore.setState({ collabBackendUrl: '' })
		useCollaborationStore.setState({ status: 'offline' })
		await show(NetworkStatusIndicator, status())

		expect(container.textContent).toBe('')
		expect(container.querySelector('[role="button"]')).toBeNull()
	})
})
