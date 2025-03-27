/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */
import { useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '@mdi/react'
import { mdiCreation } from '@mdi/js'
import AssistantDialog from '../components/AssistantDialog.vue'
import Vue from 'vue'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import { getViewPortCenter, moveElementsAroundCoords } from '../utils'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'

export function useAssistant() {
	const { excalidrawAPI } = useExcalidrawStore(
		useShallow((state) => ({
			excalidrawAPI: state.excalidrawAPI as (ExcalidrawImperativeAPI | null),
		})),
	)

	/**
	 * renders AssistantDialog.vue
	 * resolves Promise with generated Elements after dialog finished
	 */
	const getMermaidFromAssistant = useCallback(() => {
		return new Promise<{elements: ExcalidrawElement[], files: File[]}>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)
			const View = Vue.extend(AssistantDialog)
			const view = new View({
				propsData: {
					excalidrawAPI,
				},
			}).$mount(element)

			view.$on('cancel', () => {
				view.$destroy()
				reject(new Error('Assistant dialog was cancelled'))
			})

			view.$on('submit', (generatedElements: {elements: ExcalidrawElement[], files: File[]}) => {
				view.$destroy()
				resolve(generatedElements)
			})
		})
	}, [excalidrawAPI])

	/**
	 * adds generatedElements to canvas and selects them
	 */
	const loadToExcalidraw = useCallback((generatedElements: {elements: ExcalidrawElement[], files: File[]}) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		// copy elements from the current scene and add the new elements
		const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
		const movedElements = moveElementsAroundCoords(generatedElements.elements, viewportCoordsToSceneCoords(getViewPortCenter(), excalidrawAPI.getAppState()))
		elements.push(...movedElements)

		// update selected elements
		const selectedElementIds: Record<string, true> = {}
		movedElements.forEach((element: ExcalidrawElement) => {
			selectedElementIds[element.id] = true
		})

		excalidrawAPI.updateScene({
			elements,
			appState: {
				...excalidrawAPI.getAppState(),
				selectedElementIds,
			},
		})
	}, [excalidrawAPI, viewportCoordsToSceneCoords, getViewPortCenter, moveElementsAroundCoords])

	const handleAssistantToMermaid = useCallback(() => {
		getMermaidFromAssistant().then((generatedElements) => {
			// dialog is closed now
			loadToExcalidraw(generatedElements)
		})
	}, [getMermaidFromAssistant, loadToExcalidraw])

	const renderAssistantButton = useCallback(() => {
		return (
			<button
				className="dropdown-menu-button App-toolbar__extra-tools-trigger"
				aria-label="Assistant"
				aria-keyshortcuts="0"
				onClick={() => handleAssistantToMermaid()}
				title="Assistant">
				<Icon path={mdiCreation} size={1} />
			</button>
		)
	}, [handleAssistantToMermaid])

	/**
	 * injects assistant button in toolbar, handles assistant dialog
	 */
	const renderAssistant = useCallback(() => {
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
			root.render(renderAssistantButton())
		}
	}, [excalidrawAPI, renderAssistantButton])
	return { renderAssistant }
}
