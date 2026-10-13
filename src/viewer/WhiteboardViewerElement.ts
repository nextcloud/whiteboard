/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { IFile } from '@nextcloud/files'
import type { WhiteboardRootHandle } from '../utils/renderWhiteboardView.tsx'

import { loadState } from '@nextcloud/initial-state'
import { linkTo } from '@nextcloud/router'
import { getSharingToken } from '@nextcloud/sharing/public'
import { renderWhiteboardView } from '../utils/renderWhiteboardView.tsx'

import '../styles/index.scss'
import '@nextcloud/dialogs/style.css'

window.EXCALIDRAW_ASSET_PATH = linkTo('whiteboard', 'dist/')

/**
 * Keep Escape for the board: it closes its menus and dialogs, not the viewer
 *
 * @param event - The key pressed
 */
function keepEscape(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		event.stopPropagation()
	}
}

/**
 * The element the viewer of Nextcloud 36 and up renders a whiteboard with,
 * given the file to show as its `file` property (`ViewerProps` in
 * `@nextcloud/viewer`).
 */
export class WhiteboardViewerElement extends HTMLElement {
	#file?: IFile
	#root: WhiteboardRootHandle | null = null

	get file(): IFile | undefined {
		return this.#file
	}

	set file(file: IFile | undefined) {
		const changed = file?.source !== this.#file?.source
		this.#file = file
		if (changed && this.isConnected) {
			this.#render()
		}
	}

	connectedCallback(): void {
		this.addEventListener('keydown', keepEscape)
		this.#render()
		// Drawing on a touch screen would otherwise step to the next file.
		// Once the viewer listens: it does from after the element is rendered.
		queueMicrotask(() => this.dispatchEvent(new CustomEvent('update:canSwipe', { detail: [false] })))
	}

	disconnectedCallback(): void {
		this.removeEventListener('keydown', keepEscape)
		this.#unmount()
	}

	#unmount(): void {
		this.#root?.unmount()
		this.#root = null
		this.replaceChildren()
	}

	#render(): void {
		this.#unmount()
		const file = this.#file
		if (!file) {
			return
		}

		// Outside the viewer, as the preview of a link to the file, the board
		// is shown read-only
		const isEmbedded = this.closest('.viewer__modal') === null
		// An older version carries the id of the file it belongs to, and is
		// read from its own source
		const isVersion = file.source.includes('/dav/versions/')

		const container = document.createElement('div')
		container.classList.add('whiteboard')
		container.classList.toggle('whiteboard-viewer__embedding', isEmbedded)
		this.append(container)

		this.#root = renderWhiteboardView(container, {
			fileId: file.fileid ?? 0,
			isEmbedded,
			fileName: file.displayname,
			publicSharingToken: getSharingToken(),
			collabBackendUrl: loadState('whiteboard', 'collabBackendUrl', ''),
			versionSource: isVersion ? file.encodedSource : null,
			fileVersion: isVersion ? file.basename : null,
			// Side by side with another version, both are shown read-only
			isComparisonView: this.closest('.viewer__comparison') !== null,
		})
		this.dispatchEvent(new CustomEvent('loaded'))
	}
}
