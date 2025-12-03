/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useRef } from 'react'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { useShallow } from 'zustand/react/shallow'
import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport'
import EmojiPickerButton from '../components/EmojiPickerButton.vue'
import Vue from 'vue'

export function useEmojiPicker() {
	const { excalidrawAPI } = useExcalidrawStore(
		useShallow((state) => ({
			excalidrawAPI: state.excalidrawAPI as (ExcalidrawImperativeAPI | null),
		})),
	)

	const currentCursorPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

	const loadToExcalidraw = useCallback((emoji: string) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		const sceneCoords = viewportCoordsToSceneCoords({
			clientX: currentCursorPos.current.x,
			clientY: currentCursorPos.current.y,
		}, excalidrawAPI.getAppState())
		const [elem] = convertToExcalidrawElements([
			{
				type: 'text',
				text: emoji,
				x: sceneCoords.x,
				y: sceneCoords.y,
				fontSize: 20,
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
		if (hasInsertedRef.current) return
		const toolElements = document.getElementsByClassName(
			'ToolIcon_type_radio ToolIcon_size_medium',
		)

		if (!toolElements || toolElements.length === 0) {
			return
		}

		const lastToolEl = toolElements[toolElements.length - 1]
		const emojiButton = document.createElement('label')
		const div = document.createElement('div')

		emojiButton.appendChild(div)
		emojiButton.classList.add(...['ToolIcon', 'Shape'])
		lastToolEl.parentNode?.insertBefore(
			emojiButton,
			lastToolEl.previousSibling,
		)

		const View = Vue.extend(EmojiPickerButton)
		const vueComponent = new View({}).$mount(div)
		vueComponent.$on('selected', (emoji: string) => {
			loadToExcalidraw(emoji)
		})

		// Track cursor position for emoji placement
		window.addEventListener('pointermove', (ev: PointerEvent) => {
			currentCursorPos.current = { x: ev.clientX, y: ev.clientY }
		})
		hasInsertedRef.current = true
	}, [loadToExcalidraw, currentCursorPos])

	return { renderEmojiPicker }
}
