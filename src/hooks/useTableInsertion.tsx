/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useRef } from 'react'
import Vue from 'vue'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import TableEditorDialog from '../components/TableEditorDialog.vue'
import { convertMarkdownTableToImage } from '../utils/tableToImage'
import { viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { ExcalidrawImageElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'

const DOUBLE_CLICK_THRESHOLD_MS = 500

export function useTableInsertion() {
	const { excalidrawAPI } = useExcalidrawStore(
		useShallow((state) => ({
			excalidrawAPI: state.excalidrawAPI as (ExcalidrawImperativeAPI | null),
		})),
	)

	// Track last click for double-click detection
	const lastClickRef = useRef<{ elementId: string; timestamp: number } | null>(null)

	/**
	 * Opens the table editor dialog
	 * Resolves Promise with markdown content after dialog is submitted
	 */
	const openTableEditor = useCallback((initialMarkdown?: string) => {
		return new Promise<{ markdown: string }>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)
			const View = Vue.extend(TableEditorDialog)
			const view = new View({
				propsData: {
					initialMarkdown,
				},
			}).$mount(element)

			view.$on('cancel', () => {
				view.$destroy()
				reject(new Error('Table editor was cancelled'))
			})

			view.$on('submit', (tableData: { markdown: string }) => {
				view.$destroy()
				resolve(tableData)
			})
		})
	}, [])

	/**
	 * Edits an existing table element
	 */
	const editTable = useCallback(async (tableElement: ExcalidrawImageElement) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		// Get the markdown from customData
		const initialMarkdown = tableElement.customData?.tableMarkdown as string | undefined
		if (!initialMarkdown) {
			console.error('Table element does not have markdown data')
			return
		}

		try {
			const tableData = await openTableEditor(initialMarkdown)
			const newImageElement = await convertMarkdownTableToImage(tableData.markdown, excalidrawAPI)

			// Replace the existing element with the updated one
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			const elementIndex = elements.findIndex(el => el.id === tableElement.id)
			if (elementIndex !== -1) {
				elements[elementIndex] = {
					...newImageElement,
					id: tableElement.id,
					x: tableElement.x,
					y: tableElement.y,
					angle: tableElement.angle,
				}
				excalidrawAPI.updateScene({ elements })
			}
		} catch (error) {
			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to edit table:', error)
			}
		}
	}, [excalidrawAPI, openTableEditor])

	/**
	 * Inserts a table image into the whiteboard at the viewport center
	 */
	const insertTable = useCallback(async (initialMarkdown?: string) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		try {
			const tableData = await openTableEditor(initialMarkdown)
			const imageElement = await convertMarkdownTableToImage(tableData.markdown, excalidrawAPI)

			// Add the image element to the scene at the viewport center
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			const movedElements = moveElementsToViewport(
				[imageElement],
				viewportCoordsToSceneCoords(getViewportCenterPoint(), excalidrawAPI.getAppState()),
			)
			elements.push(...movedElements)

			excalidrawAPI.updateScene({ elements })
		} catch (error) {
			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to insert table:', error)
			}
		}
	}, [excalidrawAPI, openTableEditor])

	// Set up pointer down handler to detect clicks on table elements
	useEffect(() => {
		if (!excalidrawAPI) return

		// activeTool: current tool (selection, rectangle, etc.) - unused but required by API signature
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const pointerDownHandler = (_activeTool: any, state: any) => {
			const clickedElement = state.hit?.element
			if (!clickedElement || !clickedElement.customData) {
				return
			}

			// Check if this is a table element
			if (clickedElement.customData.isTable && clickedElement.type === 'image') {
				// Double-click detection: check if it's a quick second click
				const now = Date.now()
				const lastClick = lastClickRef.current
				const isDoubleClick = lastClick
					&& lastClick.elementId === clickedElement.id
					&& now - lastClick.timestamp < DOUBLE_CLICK_THRESHOLD_MS

				if (isDoubleClick) {
					// Double-click detected - fire and forget
					editTable(clickedElement).catch((error) => {
						console.error('Error editing table:', error)
					})
					lastClickRef.current = null
				} else {
					// First click
					lastClickRef.current = { elementId: clickedElement.id, timestamp: now }
				}
			}
		}

		excalidrawAPI.onPointerDown(pointerDownHandler)
	}, [excalidrawAPI, editTable])

	return { insertTable }
}
