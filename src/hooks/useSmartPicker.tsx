/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import ReactDOM from 'react-dom'
import { Icon } from '@mdi/react'
import { mdiSlashForwardBox } from '@mdi/js'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import { getLinkWithPicker } from '@nextcloud/vue/dist/Components/NcRichText.js'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'

export function useSmartPicker() {
	const { excalidrawAPI } = useExcalidrawStore()

	const addWebEmbed = useCallback((link: string) => {
		if (!excalidrawAPI) return

		const cords = excalidrawAPI
			? viewportCoordsToSceneCoords(
				{ clientX: 100, clientY: 100 },
				excalidrawAPI.getAppState(),
			)
			: { x: 0, y: 0 }

		const elements = excalidrawAPI
			.getSceneElementsIncludingDeleted()
			.slice()

		elements.push({
			link,
			id: (Math.random() + 1).toString(36).substring(7),
			x: cords.x,
			y: cords.y,
			strokeColor: '#1e1e1e',
			backgroundColor: 'transparent',
			fillStyle: 'solid',
			strokeWidth: 2,
			strokeStyle: 'solid',
			roundness: null,
			roughness: 1,
			opacity: 100,
			width: 400,
			height: 200,
			angle: 0,
			seed: 0,
			version: 0,
			versionNonce: 0,
			isDeleted: false,
			groupIds: [],
			frameId: null,
			boundElements: null,
			updated: 0,
			locked: false,
			type: 'embeddable',
			validated: true,
		})

		excalidrawAPI.updateScene({ elements })
	}, [excalidrawAPI])

	const pickFile = useCallback(() => {
		getLinkWithPicker(null, true).then((link: string) => {
			addWebEmbed(link)
		})
	}, [addWebEmbed])

	const renderSmartPickerButton = useCallback(() => {
		return (
			<button
				className="dropdown-menu-button App-toolbar__extra-tools-trigger"
				aria-label="Smart picker"
				aria-keyshortcuts="0"
				onClick={pickFile}
				title="Smart picker">
				<Icon path={mdiSlashForwardBox} size={1} />
			</button>
		)
	}, [pickFile])

	const renderSmartPicker = useCallback(() => {
		const extraTools = document.getElementsByClassName(
			'App-toolbar__extra-tools-trigger',
		)[0]

		if (extraTools) {
			const smartPick = document.createElement('label')
			smartPick.classList.add(...['ToolIcon', 'Shape'])
			extraTools.parentNode?.insertBefore(
				smartPick,
				extraTools.previousSibling,
			)
			const root = ReactDOM.createRoot(smartPick)
			root.render(renderSmartPickerButton())
		}
	}, [renderSmartPickerButton])

	return { renderSmartPicker }
}
