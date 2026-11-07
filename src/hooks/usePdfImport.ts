/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileId } from '@nextcloud/excalidraw/element/types'
import type { BinaryFileData, DataURL } from '@nextcloud/excalidraw/types'
import type { ImportedPageSize, PageSizeTarget } from '../utils/pdfImportSize.ts'

import { showError, showLoading, showSuccess, showWarning } from '@nextcloud/dialogs'
import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { n, t } from '@nextcloud/l10n'
import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useShallow } from 'zustand/react/shallow'
import PdfPageSelectionDialog from '../components/PdfPageSelectionDialog.vue'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import logger from '../utils/logger.ts'
import { formatMegabytes, getImportSizeReport, getMaxImageSizeBytes, getPageSizeLimit, getPageSizeTarget, IMPORT_TOTAL_BUDGET_BYTES } from '../utils/pdfImportSize.ts'
import { PREVIEW_MAX_DIMENSION_PX } from '../utils/pdfPageSelection.ts'
import { closePdfDocument, openPdfDocument, renderPdfPages } from '../utils/pdfToImages.ts'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport.ts'
import { mountVueComponent } from '../utils/vue.ts'

/** Horizontal gap between imported pages, in scene units. */
const PAGE_GAP_PX = 40

/** Cancelling the page selection dialog is not an error, so it never shows a toast. */
class PdfImportCancelled extends Error {}

/**
 * Why a running import was stopped: the board became read-only, or it was
 * closed (the hook unmounted or got another Excalidraw instance).
 */
class PdfImportAborted extends Error {
	constructor(readonly reason: 'readOnly' | 'closed') {
		super(`PDF import aborted: ${reason}`)
	}
}

/**
 * Lists pages with their sizes, for the size messages.
 *
 * @param pages - The pages to list.
 */
function formatPageSizes(pages: ImportedPageSize[]): string {
	return pages.map((page) => t('whiteboard', '{page} ({size} MB)', { page: page.pageNumber, size: formatMegabytes(page.byteSize) })).join(', ')
}

/**
 * Error for pages that stayed over the hard limit even at the lowest quality
 * and size, and so were not imported, naming the limit.
 *
 * @param pages - The skipped pages.
 * @param limit - The limit from getPageSizeLimit.
 */
function getSkippedPagesMessage(pages: ImportedPageSize[], limit: PageSizeTarget): string {
	const count = pages.length
	const variables = { count, max: formatMegabytes(limit.bytes), pages: formatPageSizes(pages) }

	if (limit.limit === 'admin') {
		return n(
			'whiteboard',
			'Page {pages} is larger than the maximum image size of {max} MB set by your administrator, even at the lowest quality. It was not imported.',
			'{count} pages are larger than the maximum image size of {max} MB set by your administrator, even at the lowest quality: {pages}. They were not imported.',
			count,
			variables,
		)
	}
	return n(
		'whiteboard',
		'Page {pages} is larger than {max} MB, the largest image the collaboration server passes on, even at the lowest quality. It was not imported, as others in this whiteboard would never see it.',
		'{count} pages are larger than {max} MB, the largest image the collaboration server passes on, even at the lowest quality: {pages}. They were not imported, as others in this whiteboard would never see them.',
		count,
		variables,
	)
}

/**
 * Warning for pages that were imported although they stayed over their share
 * of the import budget even at the lowest quality and size. Pages over a hard
 * limit are skipped instead, so the budget is the only target they can miss.
 *
 * @param pages - The pages over their share.
 * @param targetBytes - The target from getPageSizeTarget.
 */
function getOversizedPagesMessage(pages: ImportedPageSize[], targetBytes: number): string {
	const count = pages.length
	return n(
		'whiteboard',
		'Page {pages} is larger than {max} MB, its share of the {total} MB limit for one import, even at the lowest quality. It was imported anyway.',
		'{count} pages are larger than {max} MB, their share of the {total} MB limit for one import, even at the lowest quality: {pages}. They were imported anyway.',
		count,
		{ count, max: formatMegabytes(targetBytes), pages: formatPageSizes(pages), total: formatMegabytes(IMPORT_TOTAL_BUDGET_BYTES) },
	)
}

function isPdfFile(file: File): boolean {
	return file.type === 'application/pdf'
}

/**
 * Hands the files of a drop that also held PDFs on to Excalidraw, as a drop
 * of just those files at the same point, so images still land where they
 * were dropped. The capture listener lets it through, as it has no PDFs.
 *
 * @param ev - The original drop, already stopped.
 * @param files - The files that are not PDFs.
 */
function passDropOn(ev: DragEvent, files: File[]) {
	try {
		const dataTransfer = new DataTransfer()
		for (const file of files) {
			dataTransfer.items.add(file)
		}
		const { clientX, clientY, screenX, screenY, shiftKey, altKey, ctrlKey, metaKey } = ev
		;(ev.target ?? ev.currentTarget)?.dispatchEvent(new DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			composed: true,
			dataTransfer,
			clientX,
			clientY,
			screenX,
			screenY,
			shiftKey,
			altKey,
			ctrlKey,
			metaKey,
		}))
	} catch (error) {
		// Browsers without a DataTransfer constructor can't pass them on.
		logger.warn('[usePdfImport] Could not pass the other dropped files on', error)
		showError(n(
			'whiteboard',
			'"{names}" was not added. Drop it separately from PDF files.',
			'{count} files were not added: {names}. Drop them separately from PDF files.',
			files.length,
			{ count: files.length, names: files.map((file) => file.name).join(', ') },
		))
	}
}

export function usePdfImport() {
	const { excalidrawAPI } = useExcalidrawStore(useShallow((state) => ({
		excalidrawAPI: state.excalidrawAPI,
	})))
	const { isReadOnly } = useWhiteboardConfigStore(useShallow((state) => ({
		isReadOnly: state.isReadOnly,
	})))

	// Imports in progress, so they can be stopped when the board stops being
	// writable or goes away.
	const runningImportsRef = useRef(new Set<AbortController>())
	const abortRunningImports = useCallback((reason: PdfImportAborted['reason']) => {
		for (const controller of runningImportsRef.current) {
			controller.abort(new PdfImportAborted(reason))
		}
		runningImportsRef.current.clear()
	}, [])

	useEffect(() => {
		if (isReadOnly) {
			abortRunningImports('readOnly')
		}
	}, [isReadOnly, abortRunningImports])

	// Also runs on unmount, when the board is closed.
	useEffect(() => () => abortRunningImports('closed'), [excalidrawAPI, abortRunningImports])

	/**
	 * Resolves with the page range chosen in PdfPageSelectionDialog, or rejects
	 * with PdfImportCancelled, or with the signal's reason once it aborts, which
	 * also closes the dialog. The dialog renders its previews through
	 * renderPreview and never touches pdfjs-dist itself.
	 */
	const openPageSelectionDialog = useCallback((fileName: string, numPages: number, renderPreview: (pageNumber: number) => Promise<string>, signal: AbortSignal) => {
		return new Promise<{ start: number, end: number }>((resolve, reject) => {
			const element = document.createElement('div')
			document.body.appendChild(element)
			// Removes the abort listener once the dialog is answered.
			const listening = new AbortController()
			const view = mountVueComponent(PdfPageSelectionDialog, element, { fileName, numPages, renderPreview }, {
				cancel: () => {
					listening.abort()
					view.unmount()
					reject(new PdfImportCancelled())
				},
				submit: (range: { start: number, end: number }) => {
					listening.abort()
					view.unmount()
					resolve(range)
				},
			}, {
				removeTargetOnUnmount: true,
			})
			signal.addEventListener('abort', () => {
				view.unmount()
				reject(signal.reason)
			}, { signal: listening.signal })
		})
	}, [])

	const importPdfFile = useCallback(async (fileName: string, data: ArrayBuffer, signal: AbortSignal) => {
		if (!excalidrawAPI || isReadOnly || signal.aborted) {
			return
		}

		const toastState: { current: ReturnType<typeof showLoading> | null } = { current: null }
		let handle: Awaited<ReturnType<typeof openPdfDocument>> | null = null

		try {
			handle = await openPdfDocument(data)
			signal.throwIfAborted()

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
				range = await openPageSelectionDialog(fileName, handle.totalPages, renderPreview, signal)
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

			const maxImageSizeBytes = getMaxImageSizeBytes()
			const sizeTarget = getPageSizeTarget(maxImageSizeBytes, pagesToRender)
			const sizeLimit = getPageSizeLimit(maxImageSizeBytes)
			const { pages: renderedPages } = await renderPdfPages(handle, range, showProgress, undefined, sizeTarget.bytes, signal)
			// The last page may have finished just as the board stopped being writable.
			signal.throwIfAborted()

			toastState.current?.hideToast()

			// Like regular images over the admin's limit, pages over a hard limit
			// are refused. Pages that only miss their share of the budget are kept.
			const { skippedPages, oversizedPages } = getImportSizeReport(renderedPages, sizeTarget.bytes, sizeLimit.bytes)
			const pages = renderedPages.filter((page) => page.byteSize <= sizeLimit.bytes)
			if (skippedPages.length > 0) {
				showError(getSkippedPagesMessage(skippedPages, sizeLimit), { timeout: -1 })
			}
			if (pages.length === 0) {
				return
			}

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
			excalidrawAPI.setViewport({ target: centeredElements, fit: 'scale-down', animation: true })

			showSuccess(n('whiteboard', 'Imported {count} PDF page from "{name}".', 'Imported {count} PDF pages from "{name}".', pages.length, {
				count: pages.length,
				name: fileName,
			}))

			if (oversizedPages.length > 0) {
				showWarning(getOversizedPagesMessage(oversizedPages, sizeTarget.bytes), { timeout: -1 })
			}
		} catch (error) {
			toastState.current?.hideToast()
			if (error instanceof PdfImportAborted) {
				// A closed board has no one left to tell.
				if (error.reason === 'readOnly') {
					showWarning(t('whiteboard', 'The import of "{name}" was stopped because the whiteboard is now read-only. Nothing was imported.', { name: fileName }))
				}
			} else if (!(error instanceof PdfImportCancelled)) {
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

	// Start reading every file before any other async work: cloud-sync
	// placeholder files can become unreadable (NotReadableError) if the read
	// is delayed. The PDFs are then offered one after the other, each with its
	// own dialog, and an abort stops the ones not yet imported.
	const readFilesAndImport = useCallback(async (files: File[]) => {
		const controller = new AbortController()
		runningImportsRef.current.add(controller)
		const reads = files.map((file) => file.arrayBuffer().then(
			(data) => ({ data }),
			(error: unknown) => ({ error }),
		))

		try {
			for (const [index, file] of files.entries()) {
				if (controller.signal.aborted) {
					return
				}

				const read = await reads[index]
				if ('error' in read) {
					const { error } = read
					if (error instanceof DOMException && error.name === 'NotReadableError') {
						showError(t('whiteboard', 'The file "{name}" could not be read. Make sure it is fully downloaded and still exists.', { name: file.name }))
					} else {
						showError(t('whiteboard', 'Could not read "{name}": {message}', {
							name: file.name,
							message: error instanceof Error ? error.message : String(error),
						}))
					}
					continue
				}

				await importPdfFileRef.current(file.name, read.data, controller.signal)
			}
		} finally {
			runningImportsRef.current.delete(controller)
		}
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
			const files = Array.from(ev.dataTransfer?.files ?? [])
			const pdfFiles = files.filter(isPdfFile)
			if (pdfFiles.length === 0) {
				return
			}

			ev.preventDefault()
			ev.stopPropagation()
			const otherFiles = files.filter((file) => !isPdfFile(file))
			if (otherFiles.length > 0) {
				passDropOn(ev, otherFiles)
			}
			void readFilesAndImport(pdfFiles)
		}

		// Capture phase, so PDFs are handled before Excalidraw's own drop handler
		// and every drop without one reaches it unchanged.
		wrapper.addEventListener('drop', handleDrop, true)
		return () => wrapper.removeEventListener('drop', handleDrop, true)
	}, [excalidrawAPI, readFilesAndImport])

	const openImportDialog = useCallback(() => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'application/pdf'
		input.style.display = 'none'
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (file) {
				void readFilesAndImport([file])
			}
			input.remove()
		})
		document.body.appendChild(input)
		input.click()
	}, [readFilesAndImport])

	return { openImportDialog: isReadOnly ? undefined : openImportDialog }
}
