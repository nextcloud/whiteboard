/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useRef, useEffect } from 'react'
import * as ReactDOM from 'react-dom'
import { Icon } from '@mdi/react'
import { mdiSlashForwardBox } from '@mdi/js'
import { viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { getLinkWithPicker } from '@nextcloud/vue/dist/Components/NcRichText.js'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'

export function useSmartPicker() {
	const { excalidrawAPI } = useExcalidrawStore(
		useShallow(state => ({
			excalidrawAPI: state.excalidrawAPI,
		})),
	)

	const addWebEmbed = useCallback((link: string) => {
		const cords = viewportCoordsToSceneCoords(
			{ clientX: 100, clientY: 100 },
			excalidrawAPI!.getAppState(),
		)

		const elements = excalidrawAPI!
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

		excalidrawAPI!.updateScene({ elements })
	}, [excalidrawAPI])

	const pickFile = useCallback(() => {
		getLinkWithPicker(null, true)
			.then((link: string) => addWebEmbed(link))
			.catch((error: unknown) => {
				const message = typeof error === 'string' ? error : (error as { message?: string } | null)?.message
				if (message?.includes('User cancellation')) {
					console.debug('[SmartPicker] Picker cancelled by user')
				} else {
					console.error('[SmartPicker] Error during picking:', error)
				}
			})
	}, [addWebEmbed])

	const renderSmartPickerButton = useCallback(() => {
		return (
			<button
				className="dropdown-menu-button smart-picker-trigger"
				aria-label="Smart picker"
				aria-keyshortcuts="0"
				onClick={pickFile}
				title="Smart picker">
				<Icon path={mdiSlashForwardBox} size={1} />
			</button>
		)
	}, [pickFile])

	const hasInsertedRef = useRef(false)
	const renderSmartPicker = useCallback(() => {
		if (hasInsertedRef.current) return
		const extraTools = Array.from(document.getElementsByClassName('App-toolbar__extra-tools-trigger'))
			.find(el => !el.classList.contains('smart-picker-trigger'))
		if (!extraTools) return

		const smartPick = document.createElement('label')
		smartPick.classList.add('ToolIcon', 'Shape', 'smart-picker-container')
		extraTools.parentNode?.insertBefore(
			smartPick,
			extraTools.previousSibling,
		)
		ReactDOM.render(renderSmartPickerButton(), smartPick)
		hasInsertedRef.current = true
	}, [renderSmartPickerButton])

	useEffect(() => {
		if (excalidrawAPI) renderSmartPicker()
	}, [excalidrawAPI, renderSmartPicker])

	return { renderSmartPicker }
}
