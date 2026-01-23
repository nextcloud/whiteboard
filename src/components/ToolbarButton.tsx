/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createRoot, type Root } from 'react-dom/client'
import { Icon } from '@mdi/react'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

interface ToolbarButtonConfig {
	class: string
	buttonClass?: string
	icon?: string
	label?: string
	onClick?: () => void
	customContainer?: (container: HTMLElement) => void
}

export function resetActiveTool() {
	const excalidrawApi = useExcalidrawStore.getState().excalidrawAPI as ExcalidrawImperativeAPI | null
	if (excalidrawApi) {
		excalidrawApi.setActiveTool({ type: 'selection' })
	}
}

export function renderToolbarButton(config: ToolbarButtonConfig): Root | null {
	if (document.querySelector(`.${config.class}`)) {
		return null
	}

	const extraToolsTrigger = document.querySelector('.App-toolbar__extra-tools-trigger')
	if (!extraToolsTrigger?.parentNode) {
		return null
	}

	const container = document.createElement('label')
	container.classList.add('ToolIcon', 'Shape', config.class)
	extraToolsTrigger.parentNode.insertBefore(container, extraToolsTrigger)

	if (config.customContainer) {
		config.customContainer(container)
		return null
	}

	const handleClick = () => {
		resetActiveTool()
		config.onClick?.()
	}

	const root = createRoot(container)
	root.render(
		<button
			className={`dropdown-menu-button ${config.buttonClass || ''}`}
			aria-label={config.label}
			onClick={handleClick}
			title={config.label}>
			<Icon path={config.icon} size={1} />
		</button>,
	)
	return root
}
