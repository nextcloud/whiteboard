/**
 * - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * - SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createRoot } from 'react-dom'
import Vue from 'vue'
import { Icon } from '@mdi/react'
import { mdiCreation } from '@mdi/js'
import AssistantDialog from './AssistantDialog.vue'

async function getMermaidFromAssistant(excalidrawApi) {
	return await new Promise((resolve, reject) => {
		const element = document.createElement('div')
		document.body.appendChild(element)
		const View = Vue.extend(AssistantDialog)
		const view = new View({
			propsData: {
				excalidrawApi,
			},
		}).$mount(element)

		view.$on('cancel', () => {
			view.$destroy()
			reject(new Error('Assistant dialog was cancelled'))
		})

		view.$on('submit', (mermaid: string) => {
			view.$destroy()
			resolve(mermaid)
		})
	})
}

function renderAssistantButton(excalidrawApi) {
	return (
		<button
			className="dropdown-menu-button App-toolbar__extra-tools-trigger"
			aria-label="Assistant"
			aria-keyshortcuts="0"
			onClick={() => getMermaidFromAssistant(excalidrawApi)}
			title="Assistant">
			<Icon path={ mdiCreation } size={1} />
		</button>
	)
}

function InjectAssistant(excalidrawApi) {
	const extraTools = document.getElementsByClassName(
		'App-toolbar__extra-tools-trigger',
	)[0]
	const assistantButton = document.createElement('label')
	assistantButton.classList.add(...['ToolIcon', 'Shape'])
	if (extraTools) {
		extraTools.parentNode?.insertBefore(
			assistantButton,
			extraTools.previousSibling,
		)
		const root = createRoot(assistantButton)
		root.render(renderAssistantButton(excalidrawApi))
	}
}

export { InjectAssistant }
