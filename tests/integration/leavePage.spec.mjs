/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { guardLeavingPage } = await import('../../src/sync/leavePage.ts')

function board({ unsaved = true, fits = true, saves = true, recovery = false } = {}) {
	return {
		flush: vi.fn(() => !unsaved || fits),
		save: vi.fn(async () => {}),
		hasUnsavedChanges: vi.fn(() => unsaved),
		saveNow: vi.fn(async () => saves),
		hasUnsavedOnDevice: vi.fn(async function() {
			return recovery || this.hasUnsavedChanges()
		}),
	}
}

function link(href) {
	const element = document.createElement('a')
	element.href = href
	element.textContent = 'Log out'
	document.body.append(element)
	return element
}

describe('leaving a page with a board', () => {
	let stop = null
	let sync = null
	const navigate = vi.fn()
	const confirm = vi.fn(() => true)

	beforeEach(() => {
		vi.useFakeTimers()
		navigate.mockReset()
		confirm.mockReset()
		confirm.mockReturnValue(true)
	})

	afterEach(() => {
		stop?.()
		document.body.innerHTML = ''
		vi.useRealTimers()
	})

	// One board, or several: the open one and boards closed in the page
	function guard(current, kept = async () => false) {
		sync = current
		stop = guardLeavingPage(() => [sync].flat().filter(Boolean), kept, navigate, confirm)
	}

	function unload() {
		const event = new Event('beforeunload', { cancelable: true })
		window.dispatchEvent(event)
		return event
	}

	it('asks before leaving when unsaved changes cannot go out with the closing request, and saves meanwhile', () => {
		guard(board({ fits: false }))

		const event = unload()

		expect(event.defaultPrevented).toBe(true)
		expect(sync.save).toHaveBeenCalled()
	})

	it('lets the page go when the closing request takes the unsaved changes', () => {
		guard(board({ fits: true }))

		expect(unload().defaultPrevented).toBe(false)
		expect(sync.flush).toHaveBeenCalled()
	})

	it('saves before logging out, then logs out', async () => {
		guard({ ...board(), saveNow: vi.fn(async () => {
			sync.hasUnsavedChanges = () => false
			return true
		}) })
		const logout = link('/index.php/logout?requesttoken=abc')

		const click = new MouseEvent('click', { bubbles: true, cancelable: true })
		logout.dispatchEvent(click)
		await vi.advanceTimersByTimeAsync(0)

		expect(click.defaultPrevented).toBe(true)
		expect(sync.saveNow).toHaveBeenCalled()
		expect(confirm).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith(logout.href)
	})

	it('asks after 10 seconds whether to log out with changes not saved, and stays when told so', async () => {
		guard({ ...board(), saveNow: vi.fn(() => new Promise(() => {})) })
		confirm.mockReturnValue(false)
		const logout = link('/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(9_000)
		expect(confirm).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1_000)

		expect(confirm).toHaveBeenCalledTimes(1)
		expect(navigate).not.toHaveBeenCalled()
	})

	it('logs out with changes not saved when told so', async () => {
		guard({ ...board(), saveNow: vi.fn(async () => false) })
		const logout = link('/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)

		expect(confirm).toHaveBeenCalledTimes(1)
		expect(navigate).toHaveBeenCalledWith(logout.href)
	})

	it('logs out at once when the device keeps nothing unsaved, and leaves other links alone', async () => {
		guard(board({ unsaved: false }))
		const logout = link('/index.php/logout?requesttoken=abc')
		const files = link('/index.php/apps/files')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)
		sync = board()
		const other = new MouseEvent('click', { bubbles: true, cancelable: true })
		files.dispatchEvent(other)

		expect(confirm).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith(logout.href)
		expect(other.defaultPrevented).toBe(false)
	})

	it('logs out without a board in the page when the device keeps nothing', async () => {
		guard([])
		const logout = link('/index.php/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)

		expect(confirm).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith(logout.href)
	})

	it('asks before logging out when the device keeps changes of a board closed earlier, also with no board in the page', async () => {
		guard([], async () => true)
		confirm.mockReturnValue(false)
		const logout = link('/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)

		expect(confirm).toHaveBeenCalledTimes(1)
		expect(navigate).not.toHaveBeenCalled()
	})

	it('asks before logging out when changes set aside for recovery would be lost', async () => {
		guard(board({ unsaved: false, recovery: true }))
		confirm.mockReturnValue(false)
		const logout = link('/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)

		expect(confirm).toHaveBeenCalledTimes(1)
		expect(navigate).not.toHaveBeenCalled()
	})

	it('saves the last changes of a board closed in the page before logging out', async () => {
		const closed = { ...board(), saveNow: vi.fn(async () => {
			closed.hasUnsavedChanges = () => false
			return true
		}) }
		closed.hasUnsavedOnDevice = vi.fn(async () => closed.hasUnsavedChanges())
		guard([board({ unsaved: false }), closed])
		const logout = link('/logout?requesttoken=abc')

		logout.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		await vi.advanceTimersByTimeAsync(0)

		expect(closed.saveNow).toHaveBeenCalled()
		expect(confirm).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith(logout.href)
	})

	it('asks before leaving when the last changes of a board closed in the page cannot go out with the closing request', () => {
		guard([board({ unsaved: false }), board({ fits: false })])

		expect(unload().defaultPrevented).toBe(true)
	})
})
