/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { linkTo } from '@nextcloud/router'
import { StrictMode, lazy } from 'react'
import { createRoot } from 'react-dom'

import './viewer.css'

window.EXCALIDRAW_ASSET_PATH = linkTo('whiteboard', 'dist/')

const Component = {
	name: 'Whiteboard',
	render(createElement: (arg0: string, arg1: { attrs: { id: string } }, arg2: string) => any) {
		const App = React.lazy(() => import('./App'))
		this.$emit('update:loaded', true)
		const randomId = Math.random().toString(36).replace(/[^a-z]+/g, '').substr(2, 10);
		this.$nextTick(() => {
			const rootElement = document.getElementById('whiteboard-' + randomId)
			const root = createRoot(rootElement)

			root.render(
				<StrictMode>
					<App fileId={this.fileid} isEmbedded={this.isEmbedded}/>
				</StrictMode>,
			)
		})
		return createElement('div', {
			attrs: {
				id: 'whiteboard-' + randomId,
			},
			class: ['whiteboard', { 'whiteboard-viewer__embedding': this.isEmbedded }],
		}, 'Hello whiteboard')
	},
	props: {
		filename: {
			type: String,
			default: null,
		},
		fileid: {
			type: Number,
			default: null,
		},
		isEmbedded: {
			type: Boolean,
			default: false,
		},
	},
	data() {
		return {}
	},
}

if (typeof OCA.Viewer !== 'undefined') {
	window.OCA.Viewer.registerHandler({
		id: 'whiteboard',
		mimes: [
			'application/vnd.excalidraw+json',
		],
		component: Component,
		group: null,
		theme: 'default',
		canCompare: true,
	})
} else {
	alert('UNDEFINED')
}
