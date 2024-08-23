/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { linkTo } from '@nextcloud/router'
import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom'
import { loadState } from '@nextcloud/initial-state'

import './viewer.css'

const EXCALIDRAW_ASSET_PATH = linkTo('whiteboard', 'dist/')
const App = lazy(() => import('./App'))

const generateRandomId = () =>
	Math.random()
		.toString(36)
		.replace(/[^a-z]+/g, '')
		.substr(2, 10)

const renderApp = (rootElement, props) => {
	const root = createRoot(rootElement)
	root.render(
		<StrictMode>
			<Suspense fallback={<div>Loading...</div>}>
				<App {...props} />
			</Suspense>
		</StrictMode>,
	)
	return root
}

window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH

const publicSharingToken
	= document.getElementById('sharingToken')?.value || null

if (publicSharingToken) {
	handlePublicSharing(publicSharingToken)
} else {
	handleNonPublicSharing()
}

// Handler functions
function handlePublicSharing(token) {
	const filesTable = document.querySelector('#preview table.files-filestable')

	if (filesTable) {
		return
	}

	const fileId = loadState('whiteboard', 'file_id')

	document.addEventListener('DOMContentLoaded', () => {
		const imgframeElement = document.getElementById('preview')
		if (!imgframeElement) {
			console.error('#imgframe element not found')
			return
		}

		imgframeElement.innerHTML = ''

		const whiteboardElement = createWhiteboardElement()
		imgframeElement.appendChild(whiteboardElement)

		renderApp(whiteboardElement, {
			fileId,
			isEmbedded: false,
			fileName: document.title,
			publicSharingToken: token,
		})
	})
}

function handleNonPublicSharing() {
	const Component = createWhiteboardComponent()

	if (typeof OCA.Viewer !== 'undefined') {
		registerViewerHandler(Component)
	} else {
		alert('UNDEFINED')
	}
}

function createWhiteboardElement() {
	const element = document.createElement('div')
	element.id = `whiteboard-${generateRandomId()}`
	element.className = 'whiteboard'
	return element
}

function createWhiteboardComponent() {
	return {
		name: 'Whiteboard',
		render(createElement) {
			this.$emit('update:loaded', true)
			const randomId = generateRandomId()

			this.$nextTick(() => {
				const rootElement = document.getElementById(
					`whiteboard-${randomId}`,
				)
				rootElement.addEventListener('keydown', event => {
					if (event.key === 'Escape') {
						event.stopPropagation()
					}
				})
				this.root = renderApp(rootElement, {
					fileId: this.fileid,
					isEmbedded: this.isEmbedded,
					fileName: this.basename,
				})
			})

			return createElement(
				'div',
				{
					attrs: { id: `whiteboard-${randomId}` },
					class: [
						'whiteboard',
						{ 'whiteboard-viewer__embedding': this.isEmbedded },
					],
				},
				'',
			)
		},
		beforeDestroy() {
			this.root?.unmount()
		},
		props: {
			filename: { type: String, default: null },
			fileid: { type: Number, default: null },
			isEmbedded: { type: Boolean, default: false },
		},
		data: () => ({ root: null }),
	}
}

function registerViewerHandler(Component) {
	window.OCA.Viewer.registerHandler({
		id: 'whiteboard',
		mimes: ['application/vnd.excalidraw+json'],
		component: Component,
		group: null,
		theme: 'default',
		canCompare: true,
	})
}
