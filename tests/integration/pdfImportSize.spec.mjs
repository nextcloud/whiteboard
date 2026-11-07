/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadState } from '@nextcloud/initial-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	formatMegabytes,
	getImportSizeReport,
	getMaxImageSizeBytes,
	getPageSizeLimit,
	getPageSizeTarget,
	IMPORT_TOTAL_BUDGET_BYTES,
} from '../../src/utils/pdfImportSize.ts'
import { MAX_SOCKET_PAGE_BYTES } from '../../src/utils/pdfToImages.ts'

vi.mock('@nextcloud/initial-state', () => ({ loadState: vi.fn() }))

const MB = 1024 * 1024

describe('getMaxImageSizeBytes', () => {
	afterEach(() => {
		vi.mocked(loadState).mockReset()
	})

	it('reads maxFileSize, in MB, with the same default of 10 as App.tsx', () => {
		vi.mocked(loadState).mockImplementation((_app, _key, fallback) => fallback)
		expect(getMaxImageSizeBytes()).toBe(10 * MB)
		expect(loadState).toHaveBeenCalledWith('whiteboard', 'maxFileSize', 10)
	})

	it('accepts the value as a string', () => {
		vi.mocked(loadState).mockReturnValue('2')
		expect(getMaxImageSizeBytes()).toBe(2 * MB)
	})

	it('returns null for zero, negative or non-numeric values', () => {
		for (const value of [0, -1, 'abc']) {
			vi.mocked(loadState).mockReturnValue(value)
			expect(getMaxImageSizeBytes()).toBeNull()
		}
	})
})

describe('getPageSizeTarget', () => {
	it('uses the admin\'s maximum image size when it is the smallest limit', () => {
		expect(getPageSizeTarget(1 * MB, 1)).toEqual({ bytes: 1 * MB, limit: 'admin' })
	})

	it('uses the collab server\'s message limit when the admin allows more', () => {
		expect(getPageSizeTarget(10 * MB, 1)).toEqual({ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'socket' })
		expect(getPageSizeTarget(null, 1)).toEqual({ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'socket' })
	})

	it('shares the import budget evenly when it is the smallest limit', () => {
		expect(getPageSizeTarget(10 * MB, 50)).toEqual({ bytes: Math.floor(IMPORT_TOTAL_BUDGET_BYTES / 50), limit: 'importBudget' })
	})

	it('keeps an import of pages that all meet the target within the import budget', () => {
		for (const pageCount of [1, 7, 20, 50]) {
			expect(getPageSizeTarget(10 * MB, pageCount).bytes * pageCount).toBeLessThanOrEqual(IMPORT_TOTAL_BUDGET_BYTES)
		}
	})
})

describe('getPageSizeLimit', () => {
	it('is the admin\'s maximum image size when it is below the collab server\'s limit', () => {
		expect(getPageSizeLimit(1 * MB)).toEqual({ bytes: 1 * MB, limit: 'admin' })
		expect(getPageSizeLimit(MAX_SOCKET_PAGE_BYTES)).toEqual({ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'admin' })
	})

	it('is the collab server\'s limit when the admin allows larger images or set none', () => {
		expect(getPageSizeLimit(10 * MB)).toEqual({ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'socket' })
		expect(getPageSizeLimit(null)).toEqual({ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'socket' })
	})

	it('never lies below the target, so only the import budget can be missed by an imported page', () => {
		for (const maxImageSize of [null, 1 * MB, 10 * MB]) {
			for (const pageCount of [1, 7, 50]) {
				expect(getPageSizeTarget(maxImageSize, pageCount).bytes).toBeLessThanOrEqual(getPageSizeLimit(maxImageSize).bytes)
			}
		}
	})
})

describe('getImportSizeReport', () => {
	const pages = [
		{ pageNumber: 3, byteSize: 3 * MB },
		{ pageNumber: 4, byteSize: 1 * MB },
		{ pageNumber: 5, byteSize: 2 * MB + 1 },
		{ pageNumber: 6, byteSize: 0.5 * MB },
	]

	it('lists the pages over the limit as skipped and those only over the target, in page order', () => {
		const report = getImportSizeReport(pages, 0.75 * MB, 2 * MB)

		expect(report.skippedPages).toEqual([
			{ pageNumber: 3, byteSize: 3 * MB },
			{ pageNumber: 5, byteSize: 2 * MB + 1 },
		])
		expect(report.oversizedPages).toEqual([{ pageNumber: 4, byteSize: 1 * MB }])
	})

	it('counts only the imported pages in the total', () => {
		expect(getImportSizeReport(pages, 0.75 * MB, 2 * MB).totalBytes).toBe(1.5 * MB)
	})

	it('neither skips nor flags a page of exactly the limit or target size', () => {
		const report = getImportSizeReport([{ pageNumber: 1, byteSize: 2 * MB }], 2 * MB, 2 * MB)
		expect(report.skippedPages).toEqual([])
		expect(report.oversizedPages).toEqual([])
	})
})

describe('formatMegabytes', () => {
	it('counts 1024 × 1024 bytes per MB, with at most two decimals', () => {
		expect(formatMegabytes(10 * MB)).toBe('10')
		expect(formatMegabytes(2.25 * MB)).toBe('2.25')
		expect(formatMegabytes(IMPORT_TOTAL_BUDGET_BYTES / 50)).toBe('0.4')
		expect(formatMegabytes(0.426 * MB)).toBe('0.43')
	})
})
