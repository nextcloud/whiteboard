/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment happy-dom

import { showError, showSuccess, showWarning } from '@nextcloud/dialogs'
import { loadState } from '@nextcloud/initial-state'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePdfImport } from '../../src/hooks/usePdfImport.ts'
import { useExcalidrawStore } from '../../src/stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore.ts'
import { IMPORT_TOTAL_BUDGET_BYTES } from '../../src/utils/pdfImportSize.ts'
import { MAX_SOCKET_PAGE_BYTES } from '../../src/utils/pdfToImages.ts'
import { closePdfDocument, openPdfDocument, renderPdfPages } from '../../src/utils/pdfToImages.ts'
import { mountVueComponent } from '../../src/utils/vue.ts'

vi.mock('@nextcloud/dialogs', () => ({
	showError: vi.fn(),
	showLoading: vi.fn(() => ({ hideToast: vi.fn() })),
	showSuccess: vi.fn(),
	showWarning: vi.fn(),
}))
vi.mock('@nextcloud/initial-state', () => ({ loadState: vi.fn() }))
vi.mock('@nextcloud/excalidraw', () => ({
	convertToExcalidrawElements: vi.fn((specs) => specs.map((spec, index) => ({ ...spec, id: `element-${index}` }))),
	getCommonBounds: vi.fn(() => [0, 100, 0, 100]),
	viewportCoordsToSceneCoords: vi.fn(() => ({ x: 0, y: 0 })),
}))
// Rendering is covered by pdfToImages.spec.mjs, the dialog by PdfPageSelectionDialog.spec.mjs.
vi.mock('../../src/utils/pdfToImages.ts', () => ({
	MAX_SOCKET_PAGE_BYTES: 1_875_000,
	closePdfDocument: vi.fn(async () => {}),
	openPdfDocument: vi.fn(),
	renderPdfPages: vi.fn(),
}))
vi.mock('../../src/components/PdfPageSelectionDialog.vue', () => ({ default: { name: 'PdfPageSelectionDialog' } }))
vi.mock('../../src/utils/vue.ts', () => ({ mountVueComponent: vi.fn() }))

const MB = 1024 * 1024

function page(pageNumber, byteSize = 100_000) {
	return { pageNumber, byteSize, dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', width: 1440, height: 1018, displayWidth: 1440, displayHeight: 1018 }
}

function givenMaxFileSize(megabytes) {
	vi.mocked(loadState).mockImplementation((_app, key, fallback) => (key === 'maxFileSize' ? megabytes : fallback))
}

/** Opens a PDF with numPages pages whose rendered pages are `pages` (or default ones). */
function givenPdf(numPages, pages) {
	vi.mocked(openPdfDocument).mockResolvedValue({ totalPages: numPages })
	vi.mocked(renderPdfPages).mockImplementation(async (_handle, range) => ({
		pages: pages ?? Array.from({ length: range.end - range.start + 1 }, (_, i) => page(range.start + i)),
		totalPages: numPages,
	}))
}

/** The dialog the hook mounted: its props, and its listeners to answer it with. */
function mountedDialog() {
	const [, , props, listeners] = vi.mocked(mountVueComponent).mock.calls.at(-1)
	return { props, listeners }
}

describe('usePdfImport', () => {
	let container
	let root
	let hook
	let excalidrawAPI

	function Probe() {
		hook = usePdfImport()
		return null
	}

	async function renderHook() {
		await act(async () => root.render(createElement(Probe)))
	}

	async function chooseFile(name = 'slides.pdf') {
		hook.openImportDialog()
		const input = document.querySelector('input[type=file]')
		Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.7'], name, { type: 'application/pdf' })] })
		input.dispatchEvent(new Event('change'))
	}

	async function importFinished() {
		await vi.waitFor(() => expect(closePdfDocument).toHaveBeenCalled())
	}

	beforeEach(async () => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true
		vi.mocked(mountVueComponent).mockReturnValue({ unmount: vi.fn() })
		givenMaxFileSize(1)

		excalidrawAPI = {
			addFiles: vi.fn(),
			getAppState: vi.fn(() => ({})),
			getSceneElementsIncludingDeleted: vi.fn(() => []),
			setViewport: vi.fn(),
			updateScene: vi.fn(),
		}
		useExcalidrawStore.setState({ excalidrawAPI })
		useWhiteboardConfigStore.setState({ isReadOnly: false })

		container = document.createElement('div')
		container.className = 'excalidraw-wrapper'
		document.body.appendChild(container)
		root = createRoot(document.createElement('div'))
		await renderHook()
	})

	afterEach(async () => {
		// Unmounting twice is a no-op, for tests that close the board themselves.
		await act(async () => root.unmount())
		document.body.innerHTML = ''
		vi.clearAllMocks()
	})

	it('imports a single-page PDF without asking which pages', async () => {
		givenPdf(1)

		await chooseFile()
		await importFinished()

		expect(mountVueComponent).not.toHaveBeenCalled()
		expect(renderPdfPages).toHaveBeenCalledWith(expect.anything(), { start: 1, end: 1 }, expect.any(Function), undefined, 1 * MB, expect.any(AbortSignal))
		expect(excalidrawAPI.addFiles).toHaveBeenCalledWith([expect.objectContaining({ mimeType: 'image/png' })])
		expect(excalidrawAPI.updateScene).toHaveBeenCalledWith({ elements: [expect.objectContaining({ type: 'image' })] })
		expect(showSuccess).toHaveBeenCalledWith('Imported 1 PDF page from "slides.pdf".')
		expect(showWarning).not.toHaveBeenCalled()
	})

	it('imports the range chosen in the page selection dialog, side by side in one group', async () => {
		givenPdf(5)

		await chooseFile()
		await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
		const { props, listeners } = mountedDialog()
		expect(props).toMatchObject({ fileName: 'slides.pdf', numPages: 5 })
		listeners.submit({ start: 2, end: 4 })
		await importFinished()

		expect(renderPdfPages).toHaveBeenLastCalledWith(expect.anything(), { start: 2, end: 4 }, expect.any(Function), undefined, 1 * MB, expect.any(AbortSignal))
		const [{ elements }] = excalidrawAPI.updateScene.mock.calls[0]
		expect(elements).toHaveLength(3)
		expect(new Set(elements.map((element) => element.groupIds[0])).size).toBe(1)
		expect(elements[1].x - elements[0].x).toBeGreaterThanOrEqual(elements[0].width)
		expect(showSuccess).toHaveBeenCalledWith('Imported 3 PDF pages from "slides.pdf".')
	})

	it('imports nothing and shows no error when the dialog is cancelled', async () => {
		givenPdf(5)

		await chooseFile()
		await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
		mountedDialog().listeners.cancel()
		await importFinished()

		expect(excalidrawAPI.addFiles).not.toHaveBeenCalled()
		expect(showError).not.toHaveBeenCalled()
		expect(showSuccess).not.toHaveBeenCalled()
	})

	it('skips pages that stay over the maximum image size, names them with their size and the admin limit, and imports the rest', async () => {
		givenPdf(4, [page(1), page(2, 2.5 * MB), page(3, 3 * MB), page(4, 1 * MB)])

		await chooseFile()
		await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
		mountedDialog().listeners.submit({ start: 1, end: 4 })
		await importFinished()

		// Page 4 is exactly at the limit, so it is kept.
		expect(excalidrawAPI.addFiles.mock.calls[0][0]).toHaveLength(2)
		expect(excalidrawAPI.updateScene.mock.calls[0][0].elements).toHaveLength(2)
		expect(showSuccess).toHaveBeenCalledWith('Imported 2 PDF pages from "slides.pdf".')
		expect(showError).toHaveBeenCalledTimes(1)
		expect(showError).toHaveBeenCalledWith('2 pages are larger than the maximum image size of 1 MB set by your administrator, even at the lowest quality: 2 (2.5 MB), 3 (3 MB). They were not imported.', { timeout: -1 })
		expect(showWarning).not.toHaveBeenCalled()
	})

	it('imports nothing when the only page stays over the limit, and says so in the singular', async () => {
		givenPdf(1, [page(1, 2.5 * MB)])

		await chooseFile()
		await importFinished()

		expect(showError).toHaveBeenCalledWith('Page 1 (2.5 MB) is larger than the maximum image size of 1 MB set by your administrator, even at the lowest quality. It was not imported.', { timeout: -1 })
		expect(excalidrawAPI.addFiles).not.toHaveBeenCalled()
		expect(excalidrawAPI.updateScene).not.toHaveBeenCalled()
		expect(excalidrawAPI.setViewport).not.toHaveBeenCalled()
		expect(showSuccess).not.toHaveBeenCalled()
	})

	it('shares the import budget across 50 pages of ~0.5 MB, so they fit it without a warning', async () => {
		givenMaxFileSize(10)
		const pageCount = 50
		givenPdf(pageCount)
		// Stand-in for the compression in renderPdfPages: each page shrinks to its target.
		vi.mocked(renderPdfPages).mockImplementation(async (_handle, range, _onProgress, _maxDimensionPx, maxPageBytes) => ({
			pages: Array.from({ length: range.end - range.start + 1 }, (_, i) => page(range.start + i, Math.min(0.5 * MB, maxPageBytes))),
			totalPages: pageCount,
		}))

		await chooseFile()
		await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
		mountedDialog().listeners.submit({ start: 1, end: pageCount })
		await importFinished()

		expect(renderPdfPages).toHaveBeenLastCalledWith(expect.anything(), { start: 1, end: pageCount }, expect.any(Function), undefined, Math.floor(IMPORT_TOTAL_BUDGET_BYTES / pageCount), expect.any(AbortSignal))
		const files = excalidrawAPI.addFiles.mock.calls[0][0]
		expect(files).toHaveLength(pageCount)
		const totalBytes = vi.mocked(renderPdfPages).mock.results.at(-1).value.then(({ pages }) => pages.reduce((sum, { byteSize }) => sum + byteSize, 0))
		expect(await totalBytes).toBeLessThanOrEqual(IMPORT_TOTAL_BUDGET_BYTES)
		expect(showWarning).not.toHaveBeenCalled()
	})

	it('names the import budget share when a page stays over it', async () => {
		givenMaxFileSize(10)
		const pageCount = 50
		givenPdf(pageCount, Array.from({ length: pageCount }, (_, i) => page(i + 1, i === 6 ? 0.5 * MB : 0.3 * MB)))

		await chooseFile()
		await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
		mountedDialog().listeners.submit({ start: 1, end: pageCount })
		await importFinished()

		expect(excalidrawAPI.addFiles.mock.calls[0][0]).toHaveLength(pageCount)
		expect(showWarning).toHaveBeenCalledWith('Page 7 (0.5 MB) is larger than 0.4 MB, its share of the 20 MB limit for one import, even at the lowest quality. It was imported anyway.', { timeout: -1 })
	})

	it('skips a page over the collab server\'s limit when the admin allows larger images, as others would never receive it', async () => {
		givenMaxFileSize(10)
		givenPdf(1, [page(1, 2 * MB)])

		await chooseFile()
		await importFinished()

		expect(renderPdfPages).toHaveBeenCalledWith(expect.anything(), { start: 1, end: 1 }, expect.any(Function), undefined, MAX_SOCKET_PAGE_BYTES, expect.any(AbortSignal))
		expect(showError).toHaveBeenCalledWith('Page 1 (2 MB) is larger than 1.79 MB, the largest image the collaboration server passes on, even at the lowest quality. It was not imported, as others in this whiteboard would never see it.', { timeout: -1 })
		expect(excalidrawAPI.addFiles).not.toHaveBeenCalled()
	})

	it('falls back to the collab server\'s limit when the admin setting is not a positive number', async () => {
		givenMaxFileSize(0)
		givenPdf(1)

		await chooseFile()
		await importFinished()

		expect(renderPdfPages).toHaveBeenCalledWith(expect.anything(), { start: 1, end: 1 }, expect.any(Function), undefined, MAX_SOCKET_PAGE_BYTES, expect.any(AbortSignal))
		expect(showWarning).not.toHaveBeenCalled()
	})

	it('shows an error and closes the document when rendering fails', async () => {
		givenPdf(1)
		vi.mocked(renderPdfPages).mockRejectedValue(new Error('Timed out rendering page 1.'))

		await chooseFile()
		await importFinished()

		expect(showError).toHaveBeenCalledWith('Could not import PDF "slides.pdf": Timed out rendering page 1.')
		expect(excalidrawAPI.addFiles).not.toHaveBeenCalled()
	})

	it('handles PDFs dropped on the board and leaves other drops to Excalidraw', async () => {
		givenPdf(1)
		const drop = (file) => {
			const event = new Event('drop', { bubbles: true, cancelable: true })
			Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
			container.dispatchEvent(event)
			return event
		}

		const imageDrop = drop(new File(['x'], 'photo.png', { type: 'image/png' }))
		const pdfDrop = drop(new File(['%PDF-1.7'], 'dropped.pdf', { type: 'application/pdf' }))
		await importFinished()

		expect(imageDrop.defaultPrevented).toBe(false)
		expect(pdfDrop.defaultPrevented).toBe(true)
		expect(openPdfDocument).toHaveBeenCalledTimes(1)
		expect(showSuccess).toHaveBeenCalledWith('Imported 1 PDF page from "dropped.pdf".')
	})

	describe('when the board stops being writable or closes', () => {
		const becomeReadOnly = () => act(async () => useWhiteboardConfigStore.setState({ isReadOnly: true }))
		const closeBoard = () => act(async () => root.unmount())

		/** Makes the next render wait until the returned function is called, and keeps its signal. */
		function givenSlowRender() {
			let finish
			let signal
			vi.mocked(renderPdfPages).mockImplementation((_handle, range, _onProgress, _maxDimensionPx, _maxPageBytes, renderSignal) => {
				signal = renderSignal
				return new Promise((resolve) => {
					finish = () => resolve({ pages: [page(range.start)], totalPages: 5 })
				})
			})
			return { finish: () => finish(), signal: () => signal }
		}

		async function openDialog() {
			givenPdf(5)
			await chooseFile()
			await vi.waitFor(() => expect(mountVueComponent).toHaveBeenCalled())
			return vi.mocked(mountVueComponent).mock.results.at(-1).value
		}

		function expectNothingImported() {
			expect(excalidrawAPI.addFiles).not.toHaveBeenCalled()
			expect(excalidrawAPI.updateScene).not.toHaveBeenCalled()
			expect(showSuccess).not.toHaveBeenCalled()
			expect(showError).not.toHaveBeenCalled()
		}

		it('closes the dialog, imports nothing and says why when the board becomes read-only', async () => {
			const view = await openDialog()

			await becomeReadOnly()
			await importFinished()

			expect(view.unmount).toHaveBeenCalledTimes(1)
			expect(renderPdfPages).not.toHaveBeenCalled()
			expectNothingImported()
			expect(showWarning).toHaveBeenCalledWith('The import of "slides.pdf" was stopped because the whiteboard is now read-only. Nothing was imported.')
		})

		it('stops rendering and imports nothing when the board becomes read-only during it', async () => {
			await openDialog()
			const render = givenSlowRender()
			mountedDialog().listeners.submit({ start: 1, end: 3 })
			await vi.waitFor(() => expect(renderPdfPages).toHaveBeenCalled())

			await becomeReadOnly()
			expect(render.signal().aborted).toBe(true)
			// Even if the page in progress still finishes, it is not added.
			render.finish()
			await importFinished()

			expectNothingImported()
			expect(showWarning).toHaveBeenCalledTimes(1)
		})

		it('closes the dialog and imports nothing, silently, when the board is closed', async () => {
			const view = await openDialog()

			await closeBoard()
			await importFinished()

			expect(view.unmount).toHaveBeenCalledTimes(1)
			expectNothingImported()
			expect(showWarning).not.toHaveBeenCalled()
		})

		it('stops rendering and imports nothing when the board is closed during it', async () => {
			await openDialog()
			const render = givenSlowRender()
			mountedDialog().listeners.submit({ start: 1, end: 3 })
			await vi.waitFor(() => expect(renderPdfPages).toHaveBeenCalled())

			await closeBoard()
			expect(render.signal().aborted).toBe(true)
			render.finish()
			await importFinished()

			expectNothingImported()
			expect(showWarning).not.toHaveBeenCalled()
		})
	})

	it('offers no import on a read-only board', async () => {
		await act(async () => useWhiteboardConfigStore.setState({ isReadOnly: true }))

		expect(hook.openImportDialog).toBeUndefined()
	})
})
