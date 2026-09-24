/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { canImportAllPages, getPageRangeError, MAX_PDF_PAGES } from '../../src/utils/pdfPageSelection.ts'

describe('canImportAllPages', () => {
	it('allows all pages up to MAX_PDF_PAGES', () => {
		expect(canImportAllPages(1)).toBe(true)
		expect(canImportAllPages(MAX_PDF_PAGES)).toBe(true)
	})

	it('disallows all pages above MAX_PDF_PAGES', () => {
		expect(canImportAllPages(MAX_PDF_PAGES + 1)).toBe(false)
	})
})

describe('getPageRangeError', () => {
	it('accepts a valid range', () => {
		expect(getPageRangeError(2, 5, 10)).toBeNull()
		expect(getPageRangeError(3, 3, 10)).toBeNull()
	})

	it('rejects a start page outside the document', () => {
		expect(getPageRangeError(0, 5, 10)).toEqual({ reason: 'start' })
		expect(getPageRangeError(11, 11, 10)).toEqual({ reason: 'start' })
	})

	it('rejects an end page before the start or outside the document', () => {
		expect(getPageRangeError(5, 4, 10)).toEqual({ reason: 'end' })
		expect(getPageRangeError(5, 11, 10)).toEqual({ reason: 'end' })
	})

	it('rejects non-integer input, e.g. an emptied number field', () => {
		expect(getPageRangeError('', 5, 10)).toEqual({ reason: 'start' })
		expect(getPageRangeError(1, 2.5, 10)).toEqual({ reason: 'end' })
	})

	it('accepts exactly MAX_PDF_PAGES pages and rejects one more, with the count', () => {
		const numPages = MAX_PDF_PAGES + 20
		expect(getPageRangeError(1, MAX_PDF_PAGES, numPages)).toBeNull()
		expect(getPageRangeError(1, MAX_PDF_PAGES + 1, numPages)).toEqual({ reason: 'tooManyPages', count: MAX_PDF_PAGES + 1 })
	})
})
