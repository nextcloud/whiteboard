/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Stop Ctrl+Delete before it reaches the window, where the viewer deletes the
 * open file on it. In a board it deletes the next word of a text. Registered
 * on the document, so the board, its dialogs and menus still get the key.
 * Each board registers its own listener and releases it when it closes.
 *
 * @param isShown - Whether the board is the file the viewer shows, not one it preloads
 * @return Releases the listener
 */
export function keepCtrlDelete(isShown: () => boolean = () => true): () => void {
	const listener = (event: KeyboardEvent) => {
		if (event.key === 'Delete' && event.ctrlKey && isShown()) {
			event.stopPropagation()
		}
	}
	document.addEventListener('keydown', listener)
	return () => document.removeEventListener('keydown', listener)
}
