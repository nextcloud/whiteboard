/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import logger from '../../src/utils/logger.ts'
import { getPageSizeTarget, IMPORT_TOTAL_BUDGET_BYTES } from '../../src/utils/pdfImportSize.ts'
import {
	A3_LONG_EDGE_PT,
	A4_LONG_EDGE_PT,
	BASE_RENDER_DIMENSION_PX,
	BUDGET_RETRY_SAFETY_FACTOR,
	DISPLAY_UNITS_PER_PT,
	getBudgetRetryScale,
	getDataUrlByteSize,
	getPageDisplaySize,
	getPageRenderDimension,
	getPageRenderScale,
	getPdfAssetOptions,
	JPEG_QUALITY_STEPS,
	MAX_RENDER_AREA_PX,
	MIN_RENDER_DIMENSION_PX,
	pickSmallerEncoding,
	RENDER_PX_PER_PT,
	renderPageWithinBudget,
	renderPdfPages,
	withTimeout,
} from '../../src/utils/pdfToImages.ts'

// Hand-built minimal PDF, two 300x150pt pages, no fonts/content streams needed.
const fixturePath = fileURLToPath(new URL('./fixtures/two-page.pdf', import.meta.url))

// Pages: A4 (595x842pt), A3 (842x1191pt), A1 landscape (2384x1684pt), A0
// (2384x3370pt), and 6000x1684pt, whose full-density area exceeds the cap.
const paperSizesFixturePath = fileURLToPath(new URL('./fixtures/paper-sizes.pdf', import.meta.url))

// One page each: a JPEG 2000 image, a JBIG2 image, and Japanese text in a
// font the PDF doesn't embed (predefined CMap UniJIS-UCS2-H).
const jpxFixturePath = fileURLToPath(new URL('./fixtures/jpx-image.pdf', import.meta.url))
const jbig2FixturePath = fileURLToPath(new URL('./fixtures/jbig2-image.pdf', import.meta.url))
const cjkFixturePath = fileURLToPath(new URL('./fixtures/cjk-no-embedded-font.pdf', import.meta.url))

// One A4 page covered by a noise image, where JPEG beats PNG by far.
const photoLikeFixturePath = fileURLToPath(new URL('./fixtures/photo-like.pdf', import.meta.url))

// 50 A4 pages sharing one noise image: ~0.5 MB each as JPEG 0.85, the
// reviewer's 25 MB scenario. Built by docs-dev/tools/make-measure-pdf.mjs.
const fiftyPagesFixturePath = fileURLToPath(new URL('./fixtures/fifty-photo-pages.pdf', import.meta.url))

// The directory the build copies to dist/pdfjs/.
const pdfjsAssetBaseUrl = new URL('../../node_modules/pdfjs-dist/', import.meta.url).pathname

const A2_LONG_EDGE_PT = 1684
const A1_LONG_EDGE_PT = 2384
const A0_LONG_EDGE_PT = 3370

// Longer edge in pixels a page renders at if its area stays under the cap.
const fullDensityPx = (longerEdgePt) => longerEdgePt * RENDER_PX_PER_PT

const SMALL_EDGE_PX = 600

describe('getPageRenderScale', () => {
	it('scales a landscape page so its width becomes BASE_RENDER_DIMENSION_PX', () => {
		expect(getPageRenderScale(300, 150)).toBeCloseTo(BASE_RENDER_DIMENSION_PX / 300)
	})

	it('scales a portrait page so its height becomes BASE_RENDER_DIMENSION_PX', () => {
		expect(getPageRenderScale(150, 300)).toBeCloseTo(BASE_RENDER_DIMENSION_PX / 300)
	})

	it('respects a custom max dimension', () => {
		expect(getPageRenderScale(100, 200, 1000)).toBeCloseTo(5)
	})
})

describe('getPageRenderDimension', () => {
	it('renders pages smaller than A4 at BASE_RENDER_DIMENSION_PX', () => {
		expect(getPageRenderDimension(300, 150)).toBe(BASE_RENDER_DIMENSION_PX)
	})

	it('renders A4 and A3 at BASE_RENDER_DIMENSION_PX', () => {
		expect(getPageRenderDimension(595, A4_LONG_EDGE_PT)).toBe(BASE_RENDER_DIMENSION_PX)
		expect(getPageRenderDimension(A4_LONG_EDGE_PT, A3_LONG_EDGE_PT)).toBeCloseTo(BASE_RENDER_DIMENSION_PX)
	})

	it('renders formats above A3 at A3\'s pixel density', () => {
		expect(getPageRenderDimension(A2_LONG_EDGE_PT, 1191)).toBeCloseTo(A2_LONG_EDGE_PT * BASE_RENDER_DIMENSION_PX / A3_LONG_EDGE_PT)
	})

	it('renders A1 at full A3 density', () => {
		expect(getPageRenderDimension(A1_LONG_EDGE_PT, 1684)).toBeCloseTo(fullDensityPx(A1_LONG_EDGE_PT))
	})

	it('renders A0 at full A3 density, just under the area cap', () => {
		const longerEdgePx = getPageRenderDimension(2384, A0_LONG_EDGE_PT)
		const area = longerEdgePx * (longerEdgePx * 2384 / A0_LONG_EDGE_PT)

		expect(longerEdgePx).toBeCloseTo(fullDensityPx(A0_LONG_EDGE_PT))
		expect(area).toBeLessThan(MAX_RENDER_AREA_PX)
		expect(area).toBeGreaterThan(MAX_RENDER_AREA_PX * 0.95)
	})

	it('keeps an elongated format at full density while its area fits', () => {
		// The measured 1260 x 594 mm plan: ~8.8 MP at full density.
		expect(getPageRenderDimension(3572, 1684)).toBeCloseTo(fullDensityPx(3572))
	})

	it('scales an elongated format over the area cap down to exactly MAX_RENDER_AREA_PX', () => {
		const longerEdgePx = getPageRenderDimension(6000, 1684)
		const area = longerEdgePx * (longerEdgePx * 1684 / 6000)

		expect(longerEdgePx).toBeLessThan(fullDensityPx(6000))
		expect(area).toBeCloseTo(MAX_RENDER_AREA_PX, -1)
	})
})

describe('getPageDisplaySize', () => {
	it('makes an A4 page\'s longer edge 1440 scene units', () => {
		expect(getPageDisplaySize(595, A4_LONG_EDGE_PT).height).toBeCloseTo(1440)
	})

	it('keeps pages of different paper formats in proportion', () => {
		const a4 = getPageDisplaySize(595, A4_LONG_EDGE_PT)
		const a1 = getPageDisplaySize(A1_LONG_EDGE_PT, 1684)
		expect(a1.width / a4.height).toBeCloseTo(A1_LONG_EDGE_PT / A4_LONG_EDGE_PT)
		expect(a1.width).toBeCloseTo(A1_LONG_EDGE_PT * DISPLAY_UNITS_PER_PT)
	})
})

describe('getBudgetRetryScale', () => {
	it('shrinks the edge by the square root of the size ratio, minus the safety margin', () => {
		expect(getBudgetRetryScale(4_000_000, 1_000_000)).toBeCloseTo(0.5 * BUDGET_RETRY_SAFETY_FACTOR)
	})
})

describe('getPageRenderScale against a real PDF', () => {
	it('produces a longer edge of exactly BASE_RENDER_DIMENSION_PX for every page of the fixture', async () => {
		const data = new Uint8Array(readFileSync(fixturePath))
		const loadingTask = pdfjsLib.getDocument({ data })

		try {
			const pdf = await loadingTask.promise
			expect(pdf.numPages).toBe(2)

			for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
				const page = await pdf.getPage(pageNumber)
				const baseViewport = page.getViewport({ scale: 1 })
				const scale = getPageRenderScale(baseViewport.width, baseViewport.height)
				const longerEdge = Math.max(baseViewport.width, baseViewport.height) * scale

				expect(longerEdge).toBeCloseTo(BASE_RENDER_DIMENSION_PX)

				page.cleanup()
			}
		} finally {
			await loadingTask.destroy()
		}
	})
})

describe('renderPdfPages', () => {
	// Node has no DOM canvas; @napi-rs/canvas (a pdfjs-dist dependency) stands in.
	let originalDocument

	beforeEach(() => {
		originalDocument = globalThis.document
		globalThis.document = {
			createElement: vi.fn((tagName) => {
				if (tagName !== 'canvas') {
					throw new Error(`renderPdfPages unexpectedly created a <${tagName}>`)
				}
				return createCanvas(1, 1)
			}),
		}
	})

	afterEach(() => {
		globalThis.document = originalDocument
		vi.restoreAllMocks()
	})

	async function openFixture(path = fixturePath, options = {}) {
		const data = new Uint8Array(readFileSync(path))
		const loadingTask = pdfjsLib.getDocument({ data, verbosity: 0, ...options })
		const pdf = await loadingTask.promise
		return { handle: { pdf, loadingTask, workerPort: null, totalPages: pdf.numPages }, loadingTask }
	}

	it('renders a page range using the actual PDF page numbers, with 1-indexed progress relative to the range', async () => {
		const { handle, loadingTask } = await openFixture()

		try {
			const onProgress = vi.fn()
			const result = await renderPdfPages(handle, { start: 2, end: 2 }, onProgress)

			expect(result.totalPages).toBe(2)
			expect(result.pages).toHaveLength(1)
			expect(result.pages[0].pageNumber).toBe(2)
			expect(onProgress).toHaveBeenCalledTimes(1)
			expect(onProgress).toHaveBeenCalledWith(1, 1, 2)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('respects a smaller target size for a preview render, distinct from the default final-import size', async () => {
		const { handle, loadingTask } = await openFixture()

		try {
			const previewResult = await renderPdfPages(handle, { start: 1, end: 1 }, undefined, SMALL_EDGE_PX)
			const previewLongerEdge = Math.max(previewResult.pages[0].width, previewResult.pages[0].height)

			const fullResult = await renderPdfPages(handle, { start: 1, end: 1 })
			const fullLongerEdge = Math.max(fullResult.pages[0].width, fullResult.pages[0].height)

			expect(previewLongerEdge).toBeCloseTo(SMALL_EDGE_PX, 0)
			expect(fullLongerEdge).toBeCloseTo(BASE_RENDER_DIMENSION_PX, 0)
			expect(previewLongerEdge).toBeLessThan(fullLongerEdge)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('renders A4/A3 at BASE_RENDER_DIMENSION_PX, A1/A0 at full A3 density and an over-cap format at MAX_RENDER_AREA_PX, with display sizes in paper proportion', async () => {
		const { handle, loadingTask } = await openFixture(paperSizesFixturePath)

		try {
			const { pages } = await renderPdfPages(handle, { start: 1, end: 5 })
			const [a4, a3, a1, a0, overlong] = pages
			const longerEdge = (page) => Math.max(page.width, page.height)
			const area = (page) => page.width * page.height
			const longerDisplayEdge = (page) => Math.max(page.displayWidth, page.displayHeight)

			expect(longerEdge(a4)).toBe(BASE_RENDER_DIMENSION_PX)
			expect(longerEdge(a3)).toBe(BASE_RENDER_DIMENSION_PX)
			expect(longerEdge(a1)).toBe(Math.round(fullDensityPx(A1_LONG_EDGE_PT)))
			expect(longerEdge(a0)).toBe(Math.round(fullDensityPx(A0_LONG_EDGE_PT)))
			expect(area(a0)).toBeLessThan(MAX_RENDER_AREA_PX)
			expect(longerEdge(overlong)).toBeLessThan(fullDensityPx(6000))
			// Canvas dimensions are rounded, so the area is only approximately the cap.
			expect(Math.abs(area(overlong) - MAX_RENDER_AREA_PX)).toBeLessThan(MAX_RENDER_AREA_PX * 0.001)

			expect(longerDisplayEdge(a4)).toBeCloseTo(1440)
			expect(longerDisplayEdge(a3) / longerDisplayEdge(a4)).toBeCloseTo(A3_LONG_EDGE_PT / A4_LONG_EDGE_PT)
			expect(longerDisplayEdge(a1) / longerDisplayEdge(a4)).toBeCloseTo(A1_LONG_EDGE_PT / A4_LONG_EDGE_PT)
			// Display size follows the paper even where the render resolution was capped.
			expect(longerDisplayEdge(overlong) / longerDisplayEdge(a4)).toBeCloseTo(6000 / A4_LONG_EDGE_PT)
			// A1 is landscape: its display size keeps the page's own aspect ratio.
			expect(a1.displayWidth / a1.displayHeight).toBeCloseTo(A1_LONG_EDGE_PT / 1684)
		} finally {
			await loadingTask.destroy()
		}
	})

	// The canvas renderPageWithinBudget would encode, at its first size.
	async function renderOnly(page, longerEdgePx) {
		const viewport = page.getViewport({ scale: 1 })
		const scaled = page.getViewport({ scale: getPageRenderScale(viewport.width, viewport.height, longerEdgePx) })
		const canvas = createCanvas(Math.round(scaled.width), Math.round(scaled.height))
		await page.render({ canvas, viewport: scaled, background: '#ffffff' }).promise
		return canvas
	}

	it('compresses a page that is over the byte budget as JPEG before rendering it smaller', async () => {
		const { handle, loadingTask } = await openFixture(photoLikeFixturePath)
		const startEdgePx = BASE_RENDER_DIMENSION_PX

		try {
			const page = await handle.pdf.getPage(1)
			const unconstrained = await renderPageWithinBudget(page, startEdgePx, Infinity)
			const createdBefore = document.createElement.mock.calls.length
			const budget = Math.floor(unconstrained.dataURL.length * 0.9)

			const constrained = await renderPageWithinBudget(page, startEdgePx, budget)

			expect(document.createElement.mock.calls.length - createdBefore).toBe(1)
			expect(constrained.mimeType).toBe('image/jpeg')
			expect(constrained.width).toBe(unconstrained.width)
			expect(constrained.dataURL.length).toBeLessThanOrEqual(budget)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('renders a page smaller once even the lowest JPEG quality is over the byte budget', async () => {
		const { handle, loadingTask } = await openFixture(photoLikeFixturePath)
		const startEdgePx = BASE_RENDER_DIMENSION_PX

		try {
			const page = await handle.pdf.getPage(1)
			const canvas = await renderOnly(page, startEdgePx)
			const budget = Math.floor(canvas.toDataURL('image/jpeg', JPEG_QUALITY_STEPS.at(-1)).length * 0.6)

			const constrained = await renderPageWithinBudget(page, startEdgePx, budget)

			expect(Math.max(constrained.width, constrained.height)).toBeLessThan(Math.round(startEdgePx))
			expect(Math.max(constrained.width, constrained.height)).toBeGreaterThanOrEqual(MIN_RENDER_DIMENSION_PX)
			expect(constrained.dataURL.length).toBeLessThanOrEqual(budget)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('stops at MIN_RENDER_DIMENSION_PX and returns the smallest version with a warning if nothing fits', async () => {
		const { handle, loadingTask } = await openFixture(paperSizesFixturePath)
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const startEdgePx = getPageRenderDimension(A1_LONG_EDGE_PT, 1684)

		try {
			const page = await handle.pdf.getPage(3)
			const result = await renderPageWithinBudget(page, startEdgePx, 1)

			expect(Math.max(result.width, result.height)).toBe(MIN_RENDER_DIMENSION_PX)
			expect(warn).toHaveBeenCalledTimes(1)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('keeps each page within maxPageBytes and reports its byte size', async () => {
		const { handle, loadingTask } = await openFixture(photoLikeFixturePath)
		const maxPageBytes = 100_000

		try {
			const { pages } = await renderPdfPages(handle, { start: 1, end: 1 }, undefined, undefined, maxPageBytes)

			expect(pages[0].byteSize).toBe(getDataUrlByteSize(pages[0].dataURL))
			expect(pages[0].byteSize).toBeLessThanOrEqual(maxPageBytes)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('starts at the given JPEG quality step and reports the step it ended at', async () => {
		const { handle, loadingTask } = await openFixture(photoLikeFixturePath)

		try {
			const page = await handle.pdf.getPage(1)
			const canvas = await renderOnly(page, BASE_RENDER_DIMENSION_PX)
			const result = await renderPageWithinBudget(page, BASE_RENDER_DIMENSION_PX, Infinity, 2)

			expect(result.qualityStep).toBe(2)
			expect(result.dataURL).toBe(canvas.toDataURL('image/jpeg', JPEG_QUALITY_STEPS[2]))
		} finally {
			await loadingTask.destroy()
		}
	})

	it('starts each page at the JPEG quality that sufficed for the page before it', async () => {
		const { handle, loadingTask } = await openFixture(fiftyPagesFixturePath)
		const jpegQualities = []
		document.createElement.mockImplementation(() => {
			const canvas = createCanvas(1, 1)
			const toDataURL = canvas.toDataURL.bind(canvas)
			canvas.toDataURL = (type, quality) => {
				if (type === 'image/jpeg') {
					jpegQualities.push(quality)
				}
				return toDataURL(type, quality)
			}
			return canvas
		})

		try {
			await renderPdfPages(handle, { start: 1, end: 3 }, undefined, undefined, 0.4 * 1024 * 1024)

			// Page 1 needs a second step; pages 2 and 3 start there.
			expect(jpegQualities).toEqual([JPEG_QUALITY_STEPS[0], JPEG_QUALITY_STEPS[1], JPEG_QUALITY_STEPS[1], JPEG_QUALITY_STEPS[1]])
		} finally {
			await loadingTask.destroy()
		}
	})

	it('fits 50 pages of ~0.5 MB into the import budget, without a warning', async () => {
		const { handle, loadingTask } = await openFixture(fiftyPagesFixturePath)
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const target = getPageSizeTarget(10 * 1024 * 1024, 50)

		try {
			const { pages: [unconstrained] } = await renderPdfPages(handle, { start: 1, end: 1 })
			expect(unconstrained.byteSize).toBeGreaterThan(0.45 * 1024 * 1024)
			expect(unconstrained.byteSize * 50).toBeGreaterThan(IMPORT_TOTAL_BUDGET_BYTES)

			const { pages } = await renderPdfPages(handle, { start: 1, end: 50 }, undefined, undefined, target.bytes)

			expect(target.limit).toBe('importBudget')
			expect(pages).toHaveLength(50)
			expect(pages.every((page) => page.byteSize <= target.bytes)).toBe(true)
			expect(pages.reduce((sum, page) => sum + page.byteSize, 0)).toBeLessThanOrEqual(IMPORT_TOTAL_BUDGET_BYTES)
			expect(warn).not.toHaveBeenCalled()
		} finally {
			await loadingTask.destroy()
		}
	}, 60_000)

	async function countNonWhitePixels(dataURL) {
		const image = await loadImage(dataURL)
		const canvas = createCanvas(image.width, image.height)
		const context = canvas.getContext('2d')
		// Transparent pixels would otherwise read as black.
		context.fillStyle = '#ffffff'
		context.fillRect(0, 0, image.width, image.height)
		context.drawImage(image, 0, 0)
		const { data } = context.getImageData(0, 0, image.width, image.height)
		let count = 0
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
				count++
			}
		}
		return count
	}

	it.each([
		['JPEG 2000', jpxFixturePath],
		['JBIG2', jbig2FixturePath],
	])('renders a %s image only with the wasm decoders from getPdfAssetOptions', async (_format, path) => {
		const renderFirstPage = async (options) => {
			const { handle, loadingTask } = await openFixture(path, options)
			try {
				return (await renderPdfPages(handle, { start: 1, end: 1 })).pages[0]
			} finally {
				await loadingTask.destroy()
			}
		}

		// In this order: Node runs pdf.js without a worker, and decoder options
		// set by one document stay in effect for the next.
		const blankPage = await renderFirstPage({})
		const page = await renderFirstPage(getPdfAssetOptions(pdfjsAssetBaseUrl))

		expect(await countNonWhitePixels(blankPage.dataURL)).toBe(0)
		expect(await countNonWhitePixels(page.dataURL)).toBeGreaterThan(page.width * page.height * 0.05)
	})

	it('decodes text in a non-embedded CJK font only with the CMaps from getPdfAssetOptions', async () => {
		// Node can't draw the glyphs without a system font, so this checks the CMap
		// lookup via the text layer; the browser test covers the rendering.
		const textOf = async (options) => {
			const { handle, loadingTask } = await openFixture(cjkFixturePath, options)
			try {
				const page = await handle.pdf.getPage(1)
				return (await page.getTextContent()).items.map((item) => item.str).join('')
			} finally {
				await loadingTask.destroy()
			}
		}

		expect(await textOf({})).toBe('')
		expect(await textOf(getPdfAssetOptions(pdfjsAssetBaseUrl))).toBe('日本語')
	})
})

describe('getPdfAssetOptions', () => {
	it('points every asset URL into the given directory, with the trailing slash pdf.js requires', () => {
		expect(getPdfAssetOptions('https://cloud.example/apps/whiteboard/dist/pdfjs/')).toEqual({
			cMapUrl: 'https://cloud.example/apps/whiteboard/dist/pdfjs/cmaps/',
			cMapPacked: true,
			standardFontDataUrl: 'https://cloud.example/apps/whiteboard/dist/pdfjs/standard_fonts/',
			wasmUrl: 'https://cloud.example/apps/whiteboard/dist/pdfjs/wasm/',
		})
	})
})

describe('getDataUrlByteSize', () => {
	it('returns the decoded size of a base64 data URL, minus padding', () => {
		expect(getDataUrlByteSize('data:image/png;base64,' + Buffer.from('abc').toString('base64'))).toBe(3)
		expect(getDataUrlByteSize('data:image/png;base64,' + Buffer.from('abcd').toString('base64'))).toBe(4)
		expect(getDataUrlByteSize('data:image/png;base64,' + Buffer.from('abcde').toString('base64'))).toBe(5)
	})
})

describe('pickSmallerEncoding', () => {
	it('keeps the PNG when it is smaller (typical for flat vector content)', () => {
		const png = 'data:image/png;base64,AAAA'
		const jpeg = 'data:image/jpeg;base64,AAAAAAAAAAAAAAAA'

		expect(pickSmallerEncoding(png, jpeg)).toEqual({ dataURL: png, mimeType: 'image/png' })
	})

	it('keeps the JPEG when it is smaller (typical for photographic content)', () => {
		const png = 'data:image/png;base64,AAAAAAAAAAAAAAAA'
		const jpeg = 'data:image/jpeg;base64,AAAA'

		expect(pickSmallerEncoding(png, jpeg)).toEqual({ dataURL: jpeg, mimeType: 'image/jpeg' })
	})

	it('keeps the PNG on a tie', () => {
		const png = 'data:image/png;base64,AAAA'
		const jpeg = 'data:image/jpeg;base64,BBBB'

		expect(pickSmallerEncoding(png, jpeg)).toEqual({ dataURL: png, mimeType: 'image/png' })
	})
})

describe('withTimeout', () => {
	it('resolves with the value when the promise settles before the timeout', async () => {
		await expect(withTimeout(Promise.resolve('done'), 50, 'timed out')).resolves.toBe('done')
	})

	it('rejects with the original error when the promise rejects before the timeout', async () => {
		await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'timed out')).rejects.toThrow('boom')
	})

	it('rejects with the timeout message when the promise never settles', async () => {
		const neverSettles = new Promise(() => {})
		await expect(withTimeout(neverSettles, 10, 'timed out')).rejects.toThrow('timed out')
	})
})
