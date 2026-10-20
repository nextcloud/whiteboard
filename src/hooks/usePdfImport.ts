/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileId } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { BinaryFileData, DataURL } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

import { showError, showLoading, showSuccess } from '@nextcloud/dialogs'
import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { t } from '@nextcloud/l10n'
import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useShallow } from 'zustand/react/shallow'
import PdfPageSelectionDialog from '../components/PdfPageSelectionDialog.vue'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { PREVIEW_MAX_DIMENSION_PX } from '../utils/pdfPageSelection.ts'
import { closePdfDocument, openPdfDocument, renderPdfPages } from '../utils/pdfToImages.ts'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport.ts'
import { mountVueComponent } from '../utils/vue.ts'

/** Horizontal gap between imported pages, in scene units. */
const PAGE_GAP_PX = 40

/** Cancelling the page selection dialog is not an error, so it never shows a toast. */
class PdfImportCancelled extends Error {}

export function usePdfImport() {
	const { excalidrawAPI } = useExcalidrawStore(useShallow((state) => ({
		excalidrawAPI: state.excalidrawAPI,
	})))
	const { isReadOnly } = useWhiteboardConfigStore(useShallow((state) => ({
		isReadOnly: state.isReadOnly,
	})))

	/**
	 * Resolves with the page range chosen in PdfPageSelectionDialog, or rejects
	 * with PdfImportCancelled. The dialog renders its previews through
	 * renderPreview and never touches pdfjs-dist itself.
	 */
	const openPageSelectionDialog = useCallback((fileName: string, numPages: number, renderPreview: (pageNumber: number) => Promise<string>) => {
		return new Promise<{ start: number, end: number }>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)
			const view = mountVueComponent(PdfPageSelectionDialog, element, { fileName, numPages, renderPreview }, {
				cancel: () => {
					view.unmount()
					reject(new PdfImportCancelled())
				},
				submit: (range: { start: number, end: number }) => {
					view.unmount()
					resolve(range)
				},
			}, {
				removeTargetOnUnmount: true,
			})
		})
	}, [])

	const importPdfFile = useCallback(async (fileName: string, data: ArrayBuffer) => {
		if (!excalidrawAPI || isReadOnly) {
			return
		}

		const toastState: { current: ReturnType<typeof showLoading> | null } = { current: null }
		let handle: Awaited<ReturnType<typeof openPdfDocument>> | null = null

		try {
			handle = await openPdfDocument(data)

			if (handle.totalPages === 0) {
				showError(t('whiteboard', 'The PDF "{name}" has no pages to import.', { name: fileName }))
				return
			}

			let range: { start: number, end: number }
			if (handle.totalPages === 1) {
				// Nothing to choose between, so skip the dialog and its preview.
				range = { start: 1, end: 1 }
			} else {
				const openHandle = handle
				const renderPreview = async (pageNumber: number) => {
					const { pages: previewPages } = await renderPdfPages(openHandle, { start: pageNumber, end: pageNumber }, undefined, PREVIEW_MAX_DIMENSION_PX)
					return previewPages[0].dataURL
				}
				range = await openPageSelectionDialog(fileName, handle.totalPages, renderPreview)
			}
			const pagesToRender = range.end - range.start + 1

			const showProgress = (renderedCount: number) => {
				toastState.current?.hideToast()
				toastState.current = showLoading(t('whiteboard', 'Importing pages {start}-{end} from "{name}"… ({current}/{count})', {
					start: range.start,
					end: range.end,
					name: fileName,
					current: renderedCount,
					count: pagesToRender,
				}), { timeout: -1 })
			}
			showProgress(0)

			const { pages } = await renderPdfPages(handle, range, showProgress)

			toastState.current?.hideToast()

			const groupId = uuidv4()
			const files: BinaryFileData[] = []
			const maxHeight = Math.max(...pages.map((page) => page.displayHeight))
			let cursorX = 0

			const imageSpecs = pages.map((page) => {
				const fileId = uuidv4() as FileId
				files.push({
					mimeType: page.mimeType,
					id: fileId,
					dataURL: page.dataURL as DataURL,
					created: Date.now(),
				})

				const x = cursorX
				const y = (maxHeight - page.displayHeight) / 2
				cursorX += page.displayWidth + PAGE_GAP_PX

				return {
					type: 'image' as const,
					fileId,
					x,
					y,
					width: page.displayWidth,
					height: page.displayHeight,
					groupIds: [groupId],
				}
			})

			excalidrawAPI.addFiles(files)

			const newElements = convertToExcalidrawElements(imageSpecs)
			const target = viewportCoordsToSceneCoords(getViewportCenterPoint(), excalidrawAPI.getAppState())
			const centeredElements = moveElementsToViewport(newElements, target)

			const existingElements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			excalidrawAPI.updateScene({ elements: [...existingElements, ...centeredElements] })
			// Pages are sized by paper format and can be much larger than the viewport.
			excalidrawAPI.scrollToContent(centeredElements, { fitToViewport: true, animate: true })

			showSuccess(t('whiteboard', 'Imported {count} PDF pages from "{name}".', {
				count: pages.length,
				name: fileName,
			}))
		} catch (error) {
			toastState.current?.hideToast()
			if (!(error instanceof PdfImportCancelled)) {
				showError(t('whiteboard', 'Could not import PDF "{name}": {message}', {
					name: fileName,
					message: error instanceof Error ? error.message : String(error),
				}))
			}
		} finally {
			if (handle) {
				await closePdfDocument(handle)
			}
		}
	}, [excalidrawAPI, isReadOnly, openPageSelectionDialog])

	const importPdfFileRef = useRef(importPdfFile)
	useEffect(() => {
		importPdfFileRef.current = importPdfFile
	}, [importPdfFile])

	// Read the file before any other async work: cloud-sync placeholder files
	// can become unreadable (NotReadableError) if the read is delayed.
	const readFileAndImport = useCallback(async (file: File) => {
		let data: ArrayBuffer
		try {
			data = await file.arrayBuffer()
		} catch (error) {
			if (error instanceof DOMException && error.name === 'NotReadableError') {
				showError(t('whiteboard', 'The file could not be read. Make sure it is fully downloaded and still exists.'))
			} else {
				showError(t('whiteboard', 'Could not read "{name}": {message}', {
					name: file.name,
					message: error instanceof Error ? error.message : String(error),
				}))
			}
			return
		}

		await importPdfFileRef.current(file.name, data)
	}, [])

	useEffect(() => {
		// .excalidraw-wrapper only exists once Excalidraw has mounted, which is
		// when excalidrawAPI gets set.
		if (!excalidrawAPI) {
			return
		}

		const wrapper = document.getElementsByClassName('excalidraw-wrapper')[0] as HTMLElement | undefined
		if (!wrapper) {
			return
		}

		const handleDrop = (ev: DragEvent) => {
			const file = ev.dataTransfer?.files?.[0]
			if (!file || file.type !== 'application/pdf') {
				return
			}

			ev.preventDefault()
			ev.stopPropagation()
			void readFileAndImport(file)
		}

		// Capture phase, so PDFs are handled before Excalidraw's own drop handler
		// and every other drop reaches it unchanged.
		wrapper.addEventListener('drop', handleDrop, true)
		return () => wrapper.removeEventListener('drop', handleDrop, true)
	}, [excalidrawAPI, readFileAndImport])

	const openImportDialog = useCallback(() => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'application/pdf'
		input.style.display = 'none'
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (file) {
				void readFileAndImport(file)
			}
			input.remove()
		})
		document.body.appendChild(input)
		input.click()
	}, [readFileAndImport])

	return { openImportDialog: isReadOnly ? undefined : openImportDialog }
}
