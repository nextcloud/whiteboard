/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

import logger from './logger.ts'
import { applyPromiseTryPolyfill } from './promiseTryPolyfill.ts'

/** Longer edge of an A4 page, in PDF points (1/72 inch). */
export const A4_LONG_EDGE_PT = 842

/** Longer edge of an A3 page, in PDF points (1/72 inch). */
export const A3_LONG_EDGE_PT = 1191

/**
 * Longer edge, in pixels, for pages up to and including A3. Same as the
 * image size cap Excalidraw applies to dropped images
 * (`DEFAULT_MAX_IMAGE_WIDTH_OR_HEIGHT`, not exported by the package).
 */
export const BASE_RENDER_DIMENSION_PX = 1440

/**
 * Upper bound on a rendered page's area, in pixels. Keeps well below iOS
 * Safari's canvas area limit, the tightest one among supported browsers.
 */
export const MAX_RENDER_AREA_PX = 12_000_000

/** Pixel density for pages larger than A3: A3's density at BASE_RENDER_DIMENSION_PX. */
export const RENDER_PX_PER_PT = BASE_RENDER_DIMENSION_PX / A3_LONG_EDGE_PT

/**
 * Scene units per PDF point, so pages keep their paper proportions on the
 * board and an A4 page is 1440 units long.
 */
export const DISPLAY_UNITS_PER_PT = 1440 / A4_LONG_EDGE_PT

/**
 * Upper bound on a page's data URL length. Each image is broadcast as its own
 * Socket.io message, and the collab server rejects messages above 3 MB by
 * default.
 */
const PAGE_DATAURL_BUDGET_BYTES = 2_500_000

/** How many downscaled re-renders a page over the byte budget gets. */
export const MAX_BUDGET_RETRIES = 2

/** Margin on the computed downscale factor, since encoded size only roughly tracks pixel count. */
export const BUDGET_RETRY_SAFETY_FACTOR = 0.9

const JPEG_QUALITY = 0.85

export interface RenderedPage {
	dataURL: string
	mimeType: 'image/png' | 'image/jpeg'
	/** Rendered width, in pixels. */
	width: number
	/** Rendered height, in pixels. */
	height: number
}

export interface PdfPageImage extends RenderedPage {
	/** Width on the board, in scene units. */
	displayWidth: number
	/** Height on the board, in scene units. */
	displayHeight: number
	pageNumber: number
}

export interface PdfToImagesResult {
	pages: PdfPageImage[]
	totalPages: number
}

const DOCUMENT_LOAD_TIMEOUT_MS = 20_000
const WORKER_DESTROY_TIMEOUT_MS = 5_000
const PAGE_RENDER_TIMEOUT_MS = 15_000

/**
 * Rejects with `message` if `promise` hasn't settled within `timeoutMs`.
 * A pdf.js worker that fails during startup never settles its promises, so
 * without this the import would hang silently.
 *
 * @param promise - The promise to race against the timeout.
 * @param timeoutMs - Timeout in milliseconds.
 * @param message - Error message to reject with if the timeout wins.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/**
 * Scale factor that makes a page's longer edge maxDimension pixels.
 *
 * @param baseWidth - Page width at scale 1 (72 DPI), in points.
 * @param baseHeight - Page height at scale 1 (72 DPI), in points.
 * @param maxDimension - Target size of the longer edge, in pixels.
 */
export function getPageRenderScale(baseWidth: number, baseHeight: number, maxDimension: number = BASE_RENDER_DIMENSION_PX): number {
	return maxDimension / Math.max(baseWidth, baseHeight)
}

/**
 * Longer edge, in pixels, to render a page at: BASE_RENDER_DIMENSION_PX up
 * to A3, A3's density beyond that, scaled down to MAX_RENDER_AREA_PX if the
 * area would exceed it.
 *
 * @param widthPt - Page width, in PDF points.
 * @param heightPt - Page height, in PDF points.
 */
export function getPageRenderDimension(widthPt: number, heightPt: number): number {
	const longerEdgePt = Math.max(widthPt, heightPt)
	const longerEdgePx = Math.max(longerEdgePt * RENDER_PX_PER_PT, BASE_RENDER_DIMENSION_PX)
	const pxPerPt = longerEdgePx / longerEdgePt
	if (widthPt * heightPt * pxPerPt ** 2 <= MAX_RENDER_AREA_PX) {
		return longerEdgePx
	}
	return longerEdgePt * Math.sqrt(MAX_RENDER_AREA_PX / (widthPt * heightPt))
}

/**
 * A page's size on the board, in scene units, independent of its render
 * resolution.
 *
 * @param widthPt - Page width, in PDF points.
 * @param heightPt - Page height, in PDF points.
 */
export function getPageDisplaySize(widthPt: number, heightPt: number): { width: number, height: number } {
	return { width: widthPt * DISPLAY_UNITS_PER_PT, height: heightPt * DISPLAY_UNITS_PER_PT }
}

/**
 * Factor to shrink a page's longer edge by so a re-render fits the byte
 * budget. Encoded size grows roughly with pixel count, hence the square root.
 *
 * @param actualBytes - Data URL length of the render that was too big.
 * @param budgetBytes - Byte budget to get under.
 */
export function getBudgetRetryScale(actualBytes: number, budgetBytes: number): number {
	return Math.sqrt(budgetBytes / actualBytes) * BUDGET_RETRY_SAFETY_FACTOR
}

export interface PickedEncoding {
	dataURL: string
	mimeType: 'image/png' | 'image/jpeg'
}

/**
 * Picks the smaller of a page's PNG and JPEG encodings. Which one wins
 * depends on the page's content, so both are always tried.
 *
 * @param pngDataURL - The page encoded as PNG.
 * @param jpegDataURL - The same page encoded as JPEG.
 */
export function pickSmallerEncoding(pngDataURL: string, jpegDataURL: string): PickedEncoding {
	return pngDataURL.length <= jpegDataURL.length
		? { dataURL: pngDataURL, mimeType: 'image/png' }
		: { dataURL: jpegDataURL, mimeType: 'image/jpeg' }
}

/**
 * An open PDF document and its worker, reused for the dialog's previews and
 * the final render instead of starting a new worker for each.
 */
interface PdfDocumentHandle {
	pdf: PDFDocumentProxy
	loadingTask: PDFDocumentLoadingTask
	workerPort: Worker
	totalPages: number
}

/**
 * Opens a PDF document for renderPdfPages/closePdfDocument. pdfjs-dist is
 * imported lazily so it stays out of the main bundle.
 *
 * @param pdfData - The PDF's bytes, read by the caller right away because a
 *   cloud-sync placeholder file can become unreadable after a delay.
 */
export async function openPdfDocument(pdfData: ArrayBuffer): Promise<PdfDocumentHandle> {
	applyPromiseTryPolyfill()

	const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

	// Our own worker entry, so the Promise.try polyfill runs inside the worker too.
	const workerPort = new Worker(new URL('../workers/pdfWorkerEntry.ts', import.meta.url), { type: 'module' })

	// A worker that fails to start never answers pdf.js, so surface its errors
	// right away instead of waiting for the timeout.
	const workerFailure = new Promise<never>((_resolve, reject) => {
		workerPort.onerror = (event) => {
			logger.error('[pdfToImages] PDF worker script error', event)
			reject(new Error(`PDF worker failed to start: ${event.message || 'unknown error'}`))
		}
		workerPort.onmessageerror = (event) => {
			logger.error('[pdfToImages] PDF worker message error (could not deserialize)', event)
			reject(new Error('PDF worker sent a message that could not be deserialized.'))
		}
	})
	workerFailure.catch(() => {})

	const pdfWorker = pdfjsLib.PDFWorker.create({ port: workerPort })

	const data = new Uint8Array(pdfData)
	const loadingTask = pdfjsLib.getDocument({ data, worker: pdfWorker })

	try {
		const pdf = await withTimeout(
			Promise.race([loadingTask.promise, workerFailure]),
			DOCUMENT_LOAD_TIMEOUT_MS,
			'Timed out waiting for the PDF worker to open the document.',
		)

		return { pdf, loadingTask, workerPort, totalPages: pdf.numPages }
	} catch (error) {
		await destroyDocumentAndWorker(loadingTask, workerPort)
		throw error
	}
}

async function renderPageOnce(page: PDFPageProxy, longerEdgePx: number): Promise<RenderedPage> {
	const baseViewport = page.getViewport({ scale: 1 })
	const viewport = page.getViewport({ scale: getPageRenderScale(baseViewport.width, baseViewport.height, longerEdgePx) })

	const canvas = document.createElement('canvas')
	canvas.width = Math.round(viewport.width)
	canvas.height = Math.round(viewport.height)

	await withTimeout(
		// White background: JPEG has no transparency, uncovered areas would turn black.
		page.render({ canvas, viewport, background: '#ffffff' }).promise,
		PAGE_RENDER_TIMEOUT_MS,
		`Timed out rendering page ${page.pageNumber}.`,
	)

	const rendered = {
		...pickSmallerEncoding(
			canvas.toDataURL('image/png'),
			canvas.toDataURL('image/jpeg', JPEG_QUALITY),
		),
		width: canvas.width,
		height: canvas.height,
	}

	// Free the canvas memory right away; iOS Safari reclaims it late.
	canvas.width = 0
	canvas.height = 0

	return rendered
}

/**
 * Renders a page and, if even the smaller encoding is over budgetBytes,
 * re-renders it smaller up to MAX_BUDGET_RETRIES times. If it still doesn't
 * fit, the smallest version is used and a warning logged.
 *
 * @param page - The page to render.
 * @param longerEdgePx - Initial longer edge, in pixels.
 * @param budgetBytes - Maximum data URL length.
 */
export async function renderPageWithinBudget(page: PDFPageProxy, longerEdgePx: number, budgetBytes: number = PAGE_DATAURL_BUDGET_BYTES): Promise<RenderedPage> {
	let rendered = await renderPageOnce(page, longerEdgePx)
	let smallest = rendered

	for (let retry = 0; retry < MAX_BUDGET_RETRIES && rendered.dataURL.length > budgetBytes; retry++) {
		const nextEdgePx = Math.max(rendered.width, rendered.height) * getBudgetRetryScale(rendered.dataURL.length, budgetBytes)
		rendered = await renderPageOnce(page, nextEdgePx)
		if (rendered.dataURL.length < smallest.dataURL.length) {
			smallest = rendered
		}
	}

	if (rendered.dataURL.length <= budgetBytes) {
		return rendered
	}

	logger.warn(`[pdfToImages] Page ${page.pageNumber} is still ${smallest.dataURL.length} bytes after ${MAX_BUDGET_RETRIES} downscaled re-renders (budget ${budgetBytes}); importing the smallest version.`)
	return smallest
}

/**
 * Renders a range of pages (1-indexed, inclusive) of an open PDF to images.
 *
 * @param handle - A document opened with openPdfDocument.
 * @param range - 1-indexed, inclusive page range to render.
 * @param range.start - First page to render.
 * @param range.end - Last page to render.
 * @param onProgress - Called after each page with the number of pages
 *   rendered so far in this call.
 * @param maxDimensionPx - Longer edge to render at, in pixels, for previews.
 *   Omitted for the final import, where each page gets
 *   getPageRenderDimension for its paper format.
 */
export async function renderPdfPages(
	handle: PdfDocumentHandle,
	range: { start: number, end: number },
	onProgress?: (renderedCount: number, pagesToRender: number, totalPages: number) => void,
	maxDimensionPx?: number,
): Promise<PdfToImagesResult> {
	const { pdf, totalPages } = handle
	const pagesToRender = range.end - range.start + 1
	const pages: PdfPageImage[] = []

	for (let pageNumber = range.start; pageNumber <= range.end; pageNumber++) {
		const page = await pdf.getPage(pageNumber)
		try {
			const baseViewport = page.getViewport({ scale: 1 })
			const longerEdgePx = maxDimensionPx ?? getPageRenderDimension(baseViewport.width, baseViewport.height)
			const rendered = await renderPageWithinBudget(page, longerEdgePx)
			const display = getPageDisplaySize(baseViewport.width, baseViewport.height)

			pages.push({
				...rendered,
				displayWidth: display.width,
				displayHeight: display.height,
				pageNumber,
			})
		} finally {
			page.cleanup()
		}

		onProgress?.(pageNumber - range.start + 1, pagesToRender, totalPages)
	}

	return { pages, totalPages }
}

/**
 * Destroys a document opened with openPdfDocument and terminates its worker.
 * Also safe after a cancelled import.
 *
 * @param handle - A document opened with openPdfDocument.
 */
export async function closePdfDocument(handle: PdfDocumentHandle): Promise<void> {
	await destroyDocumentAndWorker(handle.loadingTask, handle.workerPort)
}

async function destroyDocumentAndWorker(loadingTask: PDFDocumentLoadingTask, workerPort: Worker): Promise<void> {
	// destroy() can hang on a broken worker just like the initial load.
	try {
		await withTimeout(loadingTask.destroy(), WORKER_DESTROY_TIMEOUT_MS, 'Timed out destroying the PDF worker.')
	} catch (error) {
		logger.warn('[pdfToImages] Failed to cleanly destroy the PDF loading task', error)
	}

	// pdf.js only terminates workers it created itself, not a port passed in
	// via PDFWorker.create({ port }), so without this every import leaks a worker.
	try {
		workerPort.terminate()
	} catch (error) {
		logger.warn('[pdfToImages] Failed to terminate the PDF worker', error)
	}
}
