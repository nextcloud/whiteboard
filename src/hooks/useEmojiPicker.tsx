/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileId } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { imagePath } from '@nextcloud/router'
import { Notomoji } from '@svgmoji/noto'
import { useCallback, useRef } from 'react'
import EmojiData from 'svgmoji/emoji.json'
import { useShallow } from 'zustand/react/shallow'
import EmojiPickerButton from '../components/EmojiPickerButton.vue'
import { renderToolbarButton, resetActiveTool } from '../components/ToolbarButton.tsx'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import logger from '../utils/logger.ts'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport.ts'
import { mountVueComponent } from '../utils/vue.ts'

type EmojiObj = {
	native: string
	unified?: string
}

export function useEmojiPicker() {
	const { excalidrawAPI } = useExcalidrawStore(useShallow((state) => ({
		excalidrawAPI: state.excalidrawAPI as (ExcalidrawImperativeAPI | null),
	})))

	const currentCursorPos = useRef<{ x: number, y: number }>({ x: 0, y: 0 })

	const loadToExcalidraw = useCallback(async (emoji: EmojiObj) => {
		if (!excalidrawAPI) {
			logger.error('Excalidraw API is not available')
			return
		}

		const notomoji = new Notomoji({ data: EmojiData, type: 'all' })
		let emojiObj = notomoji.find(emoji.native)

		if (!emojiObj) {
			emojiObj = notomoji.find(emoji.unified?.toUpperCase() || '')
		}

		if (!emojiObj) {
			logger.error('Selected emoji could not be loaded')
			return
		}

		// Fetch the SVG data for the selected emoji
		const url = imagePath('whiteboard', 'svgmoji/' + emojiObj.hexcode + '.svg')
		const emojiSvg = await (await fetch(url)).text()
		const emojiBlob = new Blob([emojiSvg], { type: 'image/svg+xml' })
		const fr = new FileReader()
		fr.readAsDataURL(emojiBlob)
		const emojiDataURL: DataURL = await new Promise((resolve) => {
			fr.onload = () => {
				resolve(fr.result as DataURL)
			}
		})

		const constructedFile: BinaryFileData = {
			id: (Math.random() + 1).toString(36).substring(7) as FileId,
			created: Date.now(),
			mimeType: 'image/svg+xml',
			dataURL: emojiDataURL,
		}
		excalidrawAPI.addFiles([constructedFile])

		const sceneCoords = viewportCoordsToSceneCoords({
			clientX: currentCursorPos.current.x,
			clientY: currentCursorPos.current.y,
		}, excalidrawAPI.getAppState())
		const [elem] = convertToExcalidrawElements([
			{
				type: 'image',
				fileId: constructedFile.id,
				x: sceneCoords.x,
				y: sceneCoords.y,
				width: 40,
				height: 40,
			},
		])
		const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
		elements.push(elem)
		excalidrawAPI.updateScene({
			elements,
			appState: {
				...excalidrawAPI.getAppState(),
			},
		})

		const cleanup = () => {
			window.removeEventListener('pointermove', onPointerMove)
			window.removeEventListener('pointerup', cleanup)
		}

		// Update element position while moving the pointer
		const onPointerMove = (moveEv: PointerEvent) => {
			const currentScene = viewportCoordsToSceneCoords({
				clientX: moveEv.clientX,
				clientY: moveEv.clientY,
			}, excalidrawAPI.getAppState())
			const movedElem = { ...elem, x: currentScene.x, y: currentScene.y }

			// Replace the element in the current scene (preserve others)
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			const idx = elements.findIndex((e) => e.id === elem.id)
			if (idx !== -1) {
				elements[idx] = movedElem
			} else {
				elements.push(movedElem)
			}

			excalidrawAPI.updateScene({
				elements,
				appState: {
					...excalidrawAPI.getAppState(),
				},
			})
		}

		window.addEventListener('pointerup', cleanup)
		window.addEventListener('pointermove', onPointerMove)
	}, [excalidrawAPI, convertToExcalidrawElements, viewportCoordsToSceneCoords, getViewportCenterPoint, moveElementsToViewport, currentCursorPos])

	const hasInsertedRef = useRef(false)
	const renderEmojiPicker = useCallback(() => {
		renderToolbarButton({
			class: 'emoji-picker-container',
			customContainer: (container) => {
				const div = document.createElement('div')
				container.appendChild(div)
				mountVueComponent(EmojiPickerButton, div, {}, {
					open: () => resetActiveTool(),
					selected: (emoji: EmojiObj) => loadToExcalidraw(emoji),
				})
			},
		})

		if (!hasInsertedRef.current) {
			window.addEventListener('pointermove', (ev: PointerEvent) => {
				currentCursorPos.current = { x: ev.clientX, y: ev.clientY }
			})
			hasInsertedRef.current = true
		}
	}, [loadToExcalidraw])

	return { renderEmojiPicker }
}
