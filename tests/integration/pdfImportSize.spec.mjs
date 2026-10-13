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

describe('getImportSizeReport', () => {
	it('lists the pages over the target, in page order, and the total', () => {
		const report = getImportSizeReport([
			{ pageNumber: 3, byteSize: 3 * MB },
			{ pageNumber: 4, byteSize: 1 * MB },
			{ pageNumber: 5, byteSize: 2 * MB + 1 },
		], 2 * MB)

		expect(report.oversizedPages).toEqual([
			{ pageNumber: 3, byteSize: 3 * MB },
			{ pageNumber: 5, byteSize: 2 * MB + 1 },
		])
		expect(report.totalBytes).toBe(6 * MB + 1)
	})

	it('does not count a page of exactly the target size as over it', () => {
		expect(getImportSizeReport([{ pageNumber: 1, byteSize: 2 * MB }], 2 * MB).oversizedPages).toEqual([])
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
