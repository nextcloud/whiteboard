/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useRef } from 'react'
import * as ReactDOM from 'react-dom'
import Vue from 'vue'
import { Icon } from '@mdi/react'
import { mdiTable } from '@mdi/js'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import TableEditorDialog from '../components/TableEditorDialog.vue'
import { convertHtmlTableToImage } from '../utils/tableToImage'
import { tryAcquireLock, releaseLock } from '../utils/tableLocking'
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
	 * Resolves Promise with HTML content after dialog is submitted
	 */
	const openTableEditor = useCallback((initialHtml?: string) => {
		return new Promise<{ html: string }>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)

			// Instantiate the Vue component with initial data
			const View = Vue.extend(TableEditorDialog)
			const view = new View({
				propsData: {
					initialHtml,
				},
			}).$mount(element)

			view.$on('cancel', () => {
				view.$destroy()
				reject(new Error('Table editor was cancelled'))
			})

			view.$on('submit', (tableData: { html: string }) => {
				view.$destroy()
				resolve(tableData)
			})
		})
	}, [])

	/**
	 * Edits an existing table element by opening the editor dialog.
	 *
	 * The updated element is synced to other users via the normal Excalidraw onChange flow,
	 * which triggers throttled websocket broadcasts and server API persistence.
	 *
	 * @param tableElement - The table image element to edit
	 */
	const editTable = useCallback(async (tableElement: ExcalidrawImageElement) => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		// Get the HTML from customData
		const initialHtml = tableElement.customData?.tableHtml as string | undefined

		if (!initialHtml) {
			console.error('Table element does not have HTML data')
			return
		}

		// Acquire a collaborative lock to prevent simultaneous editing by multiple users
		// Lock is stored in element.customData.tableLock with user info and timestamp
		// If another user has a non-expired lock, shows an error and returns false
		const lockAcquired = tryAcquireLock(excalidrawAPI, tableElement)
		if (!lockAcquired) {
			return
		}

		try {
			const tableData = await openTableEditor(initialHtml)
			const newImageElement = await convertHtmlTableToImage(excalidrawAPI, tableData.html)

			// Replace the existing element with the updated one while preserving position
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			const elementIndex = elements.findIndex(el => el.id === tableElement.id)
			if (elementIndex !== -1) {
				const currentElement = elements[elementIndex]

				const updatedElement = {
					...newImageElement,
					// Preserve the original element's ID and position
					id: tableElement.id,
					x: tableElement.x,
					y: tableElement.y,
					angle: tableElement.angle,
					// Increment version numbers to ensure this update wins during collaborative reconciliation
					// Excalidraw uses these to resolve conflicts when multiple users edit simultaneously
					version: (currentElement.version || 0) + 1,
					versionNonce: (currentElement.versionNonce || 0) + 1,
					customData: {
						// Include the new markdown and isTable flag from the newly generated element
						...(newImageElement.customData || {}),
						// Explicitly clear the lock so other users can edit
						tableLock: undefined,
					},
				}

				elements[elementIndex] = updatedElement
				// Trigger Excalidraw's onChange which handles all sync (websocket, server API, local storage)
				excalidrawAPI.updateScene({ elements })
			}
		} catch (error) {
			// Release lock on cancel or failure
			releaseLock(excalidrawAPI, tableElement.id)

			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to edit table:', error)
			}
		}
	}, [excalidrawAPI, openTableEditor])

	/**
	 * Inserts a new table into the whiteboard at the viewport center.
	 */
	const insertTable = useCallback(async () => {
		if (!excalidrawAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		try {
			const tableData = await openTableEditor()
			const imageElement = await convertHtmlTableToImage(excalidrawAPI, tableData.html)

			// Add the image element to the scene at the viewport center
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			const movedElements = moveElementsToViewport(
				[imageElement],
				viewportCoordsToSceneCoords(getViewportCenterPoint(), excalidrawAPI.getAppState()),
			)
			elements.push(...movedElements)

			// Add to scene - this triggers onChange which syncs to other users
			excalidrawAPI.updateScene({ elements })
		} catch (error) {
			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to insert table:', error)
			}
		}
	}, [excalidrawAPI, openTableEditor])

	// Set up pointer down handler to detect double-clicks on table elements for editing
	useEffect(() => {
		if (!excalidrawAPI) return

		// Register a handler for pointer down events on the canvas
		// activeTool: current tool (selection, rectangle, etc.) - unused but required by API signature
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const pointerDownHandler = (_activeTool: any, state: any) => {
			const clickedElement = state.hit?.element
			if (!clickedElement || !clickedElement.customData) {
				return
			}

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
					// Reset to allow next double-click
					lastClickRef.current = null
				} else {
					// First click
					lastClickRef.current = { elementId: clickedElement.id, timestamp: now }
				}
			}
		}

		// Register the handler with Excalidraw's pointer down event system
		excalidrawAPI.onPointerDown(pointerDownHandler)
	}, [excalidrawAPI, editTable])

	const renderTableButton = useCallback(() => {
		return (
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
				<Icon path={mdiTable} size={0.875} />
			</div>
		)
	}, [])

	// Prevent double-insertion of the table button in the toolbar
	const hasInsertedRef = useRef(false)

	/**
	 * Injects the "Insert Table" button into Excalidraw's toolbar.
	 */
	const renderTable = useCallback(() => {
		// Only insert once to avoid duplicate buttons
		if (hasInsertedRef.current) return

		// Find the extra tools trigger element in the toolbar
		// We insert our button before this element
		const extraTools = Array.from(document.getElementsByClassName('App-toolbar__extra-tools-trigger'))
			.find(el => !el.classList.contains('table-trigger'))
		if (!extraTools) return

		const tableButton = document.createElement('button')
		tableButton.type = 'button'
		tableButton.className = 'ToolIcon_type_button ToolIcon dropdown-menu-button table-trigger'
		tableButton.setAttribute('data-testid', 'toolbar-table')
		tableButton.setAttribute('aria-label', 'Insert table')
		tableButton.setAttribute('title', 'Insert table')
		tableButton.style.padding = '0'
		tableButton.style.display = 'flex'
		tableButton.style.alignItems = 'center'
		tableButton.style.justifyContent = 'center'
		tableButton.onclick = () => insertTable()

		extraTools.parentNode?.insertBefore(
			tableButton,
			extraTools.previousSibling,
		)
		// Render the React icon component into the button
		ReactDOM.render(renderTableButton(), tableButton)
		hasInsertedRef.current = true
	}, [renderTableButton, insertTable])

	useEffect(() => {
		if (excalidrawAPI) renderTable()
	}, [excalidrawAPI, renderTable])

	return { insertTable, renderTable }
}
