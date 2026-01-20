/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useCallback, useEffect, useRef } from 'react'
import Vue from 'vue'
import { mdiTable } from '@mdi/js'
import { t } from '@nextcloud/l10n'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore'
import { useShallow } from 'zustand/react/shallow'
// @ts-expect-error - Vue component import
import TableEditorDialog from '../components/TableEditorDialog.vue'
import { renderToolbarButton } from '../components/ToolbarButton'
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
		// Get fresh values from stores to avoid stale closures
		const currentAPI = useExcalidrawStore.getState().excalidrawAPI as ExcalidrawImperativeAPI | null
		const currentReadOnly = useWhiteboardConfigStore.getState().isReadOnly

		if (!currentAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		if (currentReadOnly) {
			console.error('Table editing is disabled in read-only mode')
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
		const lockAcquired = await tryAcquireLock(currentAPI, tableElement)
		if (!lockAcquired) {
			return
		}

		try {
			const tableData = await openTableEditor(initialHtml)
			const newImageElement = await convertHtmlTableToImage(currentAPI, tableData.html)

			// Replace the existing element with the updated one while preserving position
			const elements = currentAPI.getSceneElementsIncludingDeleted().slice()
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
					// Include updated table data (tableHtml, isTable flag, and cleared lock)
					customData: newImageElement.customData,
				}

				elements[elementIndex] = updatedElement
				// Trigger Excalidraw's onChange which handles all sync (websocket, server API, local storage)
				currentAPI.updateScene({ elements })
			}
		} catch (error) {
			// Release lock on cancel or failure
			releaseLock(currentAPI, tableElement.id)

			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to edit table:', error)
			}
		}
	}, [openTableEditor])

	/**
	 * Inserts a new table into the whiteboard at the viewport center.
	 */
	const insertTable = useCallback(async () => {
		// Get fresh values from stores to avoid stale closures
		const currentAPI = useExcalidrawStore.getState().excalidrawAPI as ExcalidrawImperativeAPI | null
		const currentReadOnly = useWhiteboardConfigStore.getState().isReadOnly

		if (!currentAPI) {
			console.error('Excalidraw API is not available')
			return
		}

		if (currentReadOnly) {
			console.error('Table insertion is disabled in read-only mode')
			return
		}

		try {
			const tableData = await openTableEditor()
			const imageElement = await convertHtmlTableToImage(currentAPI, tableData.html)

			// Add the image element to the scene at the viewport center
			const elements = currentAPI.getSceneElementsIncludingDeleted().slice()
			const movedElements = moveElementsToViewport(
				[imageElement],
				viewportCoordsToSceneCoords(getViewportCenterPoint(), currentAPI.getAppState()),
			)
			elements.push(...movedElements)

			// Add to scene - this triggers onChange which syncs to other users
			currentAPI.updateScene({ elements })
		} catch (error) {
			if (error instanceof Error && error.message !== 'Table editor was cancelled') {
				console.error('Failed to insert table:', error)
			}
		}
	}, [openTableEditor])

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

	/**
	 * Check if Text app is available and compatible with table insertion feature.
	 *
	 * - Checks for createTable API (permanent check - required for basic functionality)
	 * - Checks for getHTML() method (temporary check for older Text app versions)
	 *
	 * TODO: The getHTML() check can be removed once the latest Text app version include it.
	 */
	const checkTextAppCompatibility = async (): Promise<boolean> => {
		// Permanent check: Text app must be installed and provide the createTable API
		if (!window.OCA?.Text?.createTable) {
			console.warn('Table button not shown: Text app createTable API is not available')
			return false
		}

		try {
			const testContainer = document.createElement('div')
			testContainer.style.display = 'none'
			document.body.appendChild(testContainer)

			const testEditor = await window.OCA.Text.createTable({
				el: testContainer,
				content: '| Test |\n| --- |\n| Test |\n',
			})

			testContainer.remove()

			// TODO: Remove this check once the latest Text app version exposes getHTML()
			if (typeof testEditor?.getHTML !== 'function') {
				console.warn('Table button not shown: Text app getHTML() method is not available')
				return false
			}

			return true
		} catch (error) {
			console.error('Table button not shown: Error checking Text app compatibility:', error)
			return false
		}
	}

	/**
	 * Injects the "Insert Table" button into Excalidraw's toolbar.
	 * Only renders if Text app is available and compatible.
	 */
	const renderTable = useCallback(async () => {
		const isCompatible = await checkTextAppCompatibility()
		if (!isCompatible) {
			return
		}

		renderToolbarButton({
			class: 'table-container',
			icon: mdiTable,
			label: t('whiteboard', 'Insert table'),
			onClick: insertTable,
		})
	}, [insertTable])

	useEffect(() => {
		if (excalidrawAPI) renderTable()
	}, [excalidrawAPI, renderTable])

	return { insertTable, renderTable }
}
