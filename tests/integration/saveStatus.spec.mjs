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
const { setBoardSync } = await import('../../src/sync/boardSync.ts')
const { useCollaborationStore } = await import('../../src/stores/useCollaborationStore.ts')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const status = (change = {}) => ({ unavailable: false, deviceCopyAt: null, unsavedSince: null, saving: false, failed: false, reason: null, savedAt: null, notKept: false, ...change })

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

		expect(container.querySelector('button.save-status').textContent).toContain('Saved')
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

		const button = container.querySelector('button.save-status')
		const description = document.getElementById(button.getAttribute('aria-describedby'))
		expect(button.textContent).toMatch(/Not saved since .*1:58/)
		expect(description.textContent).toMatch(/not saved/i)
		expect(description.textContent).toMatch(action)
		expect(description.textContent).not.toMatch(/can be reached/)
	})

	it('says which image is not saved when the web server refused only that', async () => {
		const since = new Date('2026-11-08T13:58:00').getTime()
		await show(SaveStatusIndicator, status({ unsavedSince: since, failed: true, reason: 'imageTooLarge' }))

		const button = container.querySelector('button.save-status')
		const description = document.getElementById(button.getAttribute('aria-describedby'))
		expect(button.textContent).toMatch(/Image added at .*1:58.* is not saved/)
		expect(description.textContent).toMatch(/other changes are saved/i)
		expect(description.textContent).toMatch(/upload limit/i)
	})

	it('says the changes are lost when the page closes once this device could not keep them', async () => {
		const since = new Date('2026-11-08T13:58:00').getTime()
		await show(SaveStatusIndicator, status({ unsavedSince: since, failed: true, notKept: true }))

		const button = container.querySelector('button.save-status')
		const description = document.getElementById(button.getAttribute('aria-describedby'))
		expect(button.textContent).toMatch(/Not saved since .*1:58/)
		expect(description.textContent).not.toMatch(/kept on this device/)
		expect(description.textContent).toMatch(/could not keep them/)
		expect(description.textContent).toMatch(/lost if you close/)
	})

	it('shows why changes are not saved when the button is pressed, as on a phone', async () => {
		const since = new Date('2026-11-08T13:58:00').getTime()
		await show(SaveStatusIndicator, status({ unsavedSince: since, failed: true, reason: 'forbidden' }))
		const button = container.querySelector('button.save-status')
		const description = document.getElementById(button.getAttribute('aria-describedby'))
		expect(button.getAttribute('aria-expanded')).toBe('false')
		expect(description.classList.contains('hidden-visually')).toBe(true)

		await act(async () => button.click())

		expect(button.getAttribute('aria-expanded')).toBe('true')
		expect(description.classList.contains('hidden-visually')).toBe(false)
		expect(description.textContent).toMatch(/no longer edit/i)
		// Named by its short text only, so the explanation is not read twice
		const name = document.getElementById(button.getAttribute('aria-labelledby')).textContent
		expect(name).toMatch(/^Not saved since .*1:58/)
		expect(name).not.toMatch(/no longer edit/i)
	})

	it('announces only that changes are not saved', async () => {
		const live = () => container.querySelector('[role="status"]')
		await show(SaveStatusIndicator, status({ savedAt: Date.now() }))
		expect(live().textContent).toBe('')
		expect(container.querySelector('button.save-status').closest('[aria-live], [role="status"]')).toBeNull()

		await act(async () => useBoardStatusStore.setState({ status: status({ unsavedSince: Date.now(), saving: true }) }))
		expect(live().textContent).toBe('')

		const since = new Date('2026-11-08T13:58:00').getTime()
		await act(async () => useBoardStatusStore.setState({ status: status({ unsavedSince: since, failed: true, reason: 'gone' }) }))
		expect(live().textContent).toMatch(/Not saved since .*1:58/)
		expect(live().textContent).toMatch(/deleted files/i)
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

	it('offers to replace a board Nextcloud cannot read with the copy on this device, saying when that copy is from', async () => {
		const sync = { fileId: 7, close: vi.fn(), fetch: vi.fn(), replaceWithDeviceCopy: vi.fn() }
		setBoardSync(sync)
		await show(BoardUnavailable, status({ unavailable: true, deviceCopyAt: new Date('2026-11-01T09:30:00').getTime() }))

		const replace = [...container.querySelectorAll('button')].find((button) => /copy on this device/.test(button.textContent))
		expect(replace.textContent).toMatch(/Nov.* 1.*9:30/)
		expect(sync.replaceWithDeviceCopy).not.toHaveBeenCalled()
		await act(async () => replace.click())
		expect(sync.replaceWithDeviceCopy).toHaveBeenCalledOnce()
		setBoardSync(null)
	})

	it.each([
		['gone', /Deleted files/],
		['forbidden', /no longer have access/],
	])('covers a board Nextcloud refused (%s) with the reason, and does not say it tries again', async (reason, text) => {
		await show(BoardUnavailable, status({ unavailable: true, reason }))

		expect(container.textContent).toContain('could not be loaded')
		expect(container.textContent).toMatch(text)
		expect(container.textContent).toMatch(/reload the page/)
		expect(container.textContent).not.toMatch(/Trying again|copy on this device/)
		expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([])
	})

	it.each([
		['could not be reached', null, /Trying again in the background/],
		['cannot read the stored file', 'unreadable', /cannot read the stored file.*earlier version of the file in Files/],
	])('offers no copy to replace a board with when this device has none, and says Nextcloud %s', async (_, reason, text) => {
		await show(BoardUnavailable, status({ unavailable: true, reason }))

		expect(container.textContent).toMatch(text)
		expect(container.textContent).not.toMatch(/copy on this device/)
		expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Try again'])
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
