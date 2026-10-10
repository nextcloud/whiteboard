/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { t } from '@nextcloud/l10n'
import { registerHandler } from '@nextcloud/viewer'

const tagName = 'whiteboard-viewer'

// Nextcloud 36 and up, on every page: the board only loads, and its element
// is only defined, the first time the viewer opens a whiteboard
registerHandler({
	id: 'whiteboard',
	displayName: t('whiteboard', 'Whiteboard'),
	tagName,
	enabled: (nodes) => nodes.every((node) => node.mime === 'application/vnd.excalidraw+json'),
	onInit: async () => {
		const { WhiteboardViewerElement } = await import('./viewer/WhiteboardViewerElement.ts')
		if (window.customElements.get(tagName) === undefined) {
			window.customElements.define(tagName, WhiteboardViewerElement)
		}
	},
	theme: 'default',
	canCompare: true,
})
