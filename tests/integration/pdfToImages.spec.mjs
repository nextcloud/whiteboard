/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import logger from '../../src/utils/logger.ts'
import {
	A3_LONG_EDGE_PT,
	A4_LONG_EDGE_PT,
	BASE_RENDER_DIMENSION_PX,
	BUDGET_RETRY_SAFETY_FACTOR,
	DISPLAY_UNITS_PER_PT,
	getBudgetRetryScale,
	getPageDisplaySize,
	getPageRenderDimension,
	getPageRenderScale,
	MAX_BUDGET_RETRIES,
	MAX_RENDER_AREA_PX,
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

	async function openFixture(path = fixturePath) {
		const data = new Uint8Array(readFileSync(path))
		const loadingTask = pdfjsLib.getDocument({ data })
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

	it('re-renders a page that is over the byte budget at a smaller size', async () => {
		const { handle, loadingTask } = await openFixture(paperSizesFixturePath)
		const startEdgePx = getPageRenderDimension(A1_LONG_EDGE_PT, 1684)

		try {
			const page = await handle.pdf.getPage(3)
			const unconstrained = await renderPageWithinBudget(page, startEdgePx, Infinity)
			const budget = Math.floor(unconstrained.dataURL.length * 0.6)

			const constrained = await renderPageWithinBudget(page, startEdgePx, budget)

			expect(Math.max(constrained.width, constrained.height)).toBeLessThan(Math.round(startEdgePx))
			expect(constrained.dataURL.length).toBeLessThanOrEqual(budget)
		} finally {
			await loadingTask.destroy()
		}
	})

	it('gives up after MAX_BUDGET_RETRIES re-renders, importing the smallest version with a warning', async () => {
		const { handle, loadingTask } = await openFixture(paperSizesFixturePath)
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const startEdgePx = getPageRenderDimension(A1_LONG_EDGE_PT, 1684)

		try {
			const page = await handle.pdf.getPage(3)
			const result = await renderPageWithinBudget(page, startEdgePx, 1)

			expect(document.createElement).toHaveBeenCalledTimes(1 + MAX_BUDGET_RETRIES)
			expect(warn).toHaveBeenCalledTimes(1)
			expect(Math.max(result.width, result.height)).toBeLessThan(Math.round(startEdgePx))
		} finally {
			await loadingTask.destroy()
		}
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
