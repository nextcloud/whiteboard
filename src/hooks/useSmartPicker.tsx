/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import { mdiSlashForwardBox } from '@mdi/js'
import { t } from '@nextcloud/l10n'
import { viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { getLinkWithPicker } from '@nextcloud/vue/dist/Components/NcRichText.js'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import { renderToolbarButton } from '../components/ToolbarButton'

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

	const renderSmartPicker = useCallback(() => {
		renderToolbarButton({
			class: 'smart-picker-container',
			icon: mdiSlashForwardBox,
			label: t('whiteboard', 'Smart picker'),
			onClick: pickFile,
		})
	}, [pickFile])

	return { renderSmartPicker }
}
