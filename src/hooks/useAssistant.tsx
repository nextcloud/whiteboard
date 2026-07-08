/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

import { mdiCreation } from '@mdi/js'
import { getCapabilities } from '@nextcloud/capabilities'
import { viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { t } from '@nextcloud/l10n'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import AssistantDialog from '../components/AssistantDialog.vue'
import { renderToolbarButton } from '../components/ToolbarButton.tsx'
import { markFileAsAiGenerated } from '../services/ai.ts'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport.ts'
import { mountVueComponent } from '../utils/vue.ts'

export function useAssistant() {
	const capabilities = getCapabilities() as { assistant?: { version: string, enabled: boolean } }
	if (!capabilities.assistant?.enabled) {
		return { renderAssistant: () => {} }
	}
	const { excalidrawAPI } = useExcalidrawStore(useShallow((state) => ({
		excalidrawAPI: state.excalidrawAPI as (ExcalidrawImperativeAPI | null),
	})))

	const fileId = useWhiteboardConfigStore((state) => state.fileId)

	/**
	 * renders AssistantDialog.vue
	 * resolves Promise with generated Elements after dialog finished
	 */
	const getMermaidFromAssistant = useCallback(() => {
		return new Promise<{ elements: ExcalidrawElement[], files: File[] }>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)
			const view = mountVueComponent(AssistantDialog, element, {}, {
				cancel: () => {
					view.unmount()
					reject(new Error('Assistant dialog was cancelled'))
				},
				submit: (generatedElements: { elements: ExcalidrawElement[], files: File[] }) => {
					view.unmount()
					resolve(generatedElements)
				},
			}, {
				removeTargetOnUnmount: true,
			})
		})
	}, [])

	/**
	 * adds generatedElements to canvas and selects them
	 */
	const loadToExcalidraw = useCallback((generatedElements: { elements: ExcalidrawElement[], files: File[] }) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		// copy elements from the current scene and add the new elements
		const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
		const movedElements = moveElementsToViewport(generatedElements.elements, viewportCoordsToSceneCoords(getViewportCenterPoint(), excalidrawAPI.getAppState()))
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
	}, [excalidrawAPI, viewportCoordsToSceneCoords, getViewportCenterPoint, moveElementsToViewport])

	const handleAssistantToMermaid = useCallback(() => {
		getMermaidFromAssistant().then((generatedElements) => {
			// dialog is closed now
			loadToExcalidraw(generatedElements)
			if (fileId) {
				markFileAsAiGenerated(fileId)
			}
		})
	}, [getMermaidFromAssistant, loadToExcalidraw, fileId])

	/**
	 * injects assistant button in toolbar, handles assistant dialog
	 */
	const renderAssistant = useCallback(() => {
		renderToolbarButton({
			class: 'assistant-container',
			icon: mdiCreation,
			label: t('whiteboard', 'Assistant'),
			onClick: handleAssistantToMermaid,
		})
	}, [handleAssistantToMermaid])

	return { renderAssistant }
}
