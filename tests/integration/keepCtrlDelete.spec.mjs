/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nextcloud/initial-state', () => ({ loadState: () => '' }))
vi.mock('@nextcloud/router', () => ({ linkTo: () => '/apps/whiteboard/' }))
vi.mock('@nextcloud/sharing/public', () => ({ getSharingToken: () => null }))
vi.mock('../../src/utils/renderWhiteboardView.tsx', () => ({ renderWhiteboardView: () => ({ unmount() {} }) }))

const { WhiteboardViewerElement } = await import('../../src/viewer/WhiteboardViewerElement.ts')
const { keepCtrlDelete } = await import('../../src/utils/keepCtrlDelete.ts')
customElements.define('whiteboard-viewer-test', WhiteboardViewerElement)

/**
 * @param {HTMLElement} parent - Where the text field is, inside the board or in a dialog outside of it
 */
function textField(parent) {
	const field = document.createElement('textarea')
	parent.append(field)
	return field
}

/**
 * @param {HTMLElement} target - The focused element
 * @param {string} key - The key pressed with Ctrl
 */
function pressCtrl(target, key) {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
}

describe('Ctrl+Delete in an open board', () => {
	let deleteFile
	let board

	// The viewer deletes the open file on Ctrl+Delete, listening on the window
	const viewerShortcut = (event) => {
		if (event.key === 'Delete' && event.ctrlKey) {
			deleteFile()
		}
	}

	beforeEach(() => {
		deleteFile = vi.fn()
		window.addEventListener('keydown', viewerShortcut)
		board = document.createElement('whiteboard-viewer-test')
		board.file = { source: 'https://cloud.example.com/remote.php/dav/files/alice/Board.whiteboard', fileid: 1, displayname: 'Board.whiteboard' }
		document.body.append(board)
	})

	afterEach(() => {
		window.removeEventListener('keydown', viewerShortcut)
		board.remove()
		document.body.replaceChildren()
	})

	it('does not delete the file while typing on the board', () => {
		const field = textField(board)
		const typed = vi.fn()
		field.addEventListener('keydown', typed)

		pressCtrl(field, 'Delete')

		expect(typed).toHaveBeenCalledOnce()
		expect(deleteFile).not.toHaveBeenCalled()
	})

	it('does not delete the file while typing in a dialog rendered outside of the board', () => {
		const dialog = document.createElement('div')
		document.body.append(dialog)

		pressCtrl(textField(dialog), 'Delete')

		expect(deleteFile).not.toHaveBeenCalled()
	})

	it('gives the shortcut back to the viewer once the board is closed', () => {
		board.remove()

		pressCtrl(textField(document.body), 'Delete')

		expect(deleteFile).toHaveBeenCalledOnce()
	})

	it('keeps protecting a board when another one closes', () => {
		const comparison = document.createElement('whiteboard-viewer-test')
		comparison.file = { source: 'https://cloud.example.com/remote.php/dav/versions/alice/versions/1/1700000000', fileid: 1, displayname: 'Board.whiteboard' }
		document.body.append(comparison)
		comparison.remove()

		pressCtrl(textField(board), 'Delete')

		expect(deleteFile).not.toHaveBeenCalled()
	})

	it('leaves the shortcut to the viewer for a board it only preloads', () => {
		board.remove()
		const preloaded = document.createElement('div')
		document.body.append(preloaded)
		const release = keepCtrlDelete(() => false)

		pressCtrl(textField(preloaded), 'Delete')
		release()

		expect(deleteFile).toHaveBeenCalledOnce()
	})
})
