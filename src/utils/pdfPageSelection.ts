/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Most pages the page selection dialog lets through in one import. */
export const MAX_PDF_PAGES = 50

/** Longer edge of the page selection dialog's preview, small so browsing pages stays fast. */
export const PREVIEW_MAX_DIMENSION_PX = 600

export type PageRangeError
	= { reason: 'start' }
		| { reason: 'end' }
		| { reason: 'tooManyPages', count: number }

/**
 * Whether "all pages" can be offered for a document.
 *
 * @param numPages - Number of pages in the document.
 */
export function canImportAllPages(numPages: number): boolean {
	return numPages <= MAX_PDF_PAGES
}

/**
 * Checks a page range entered in the page selection dialog.
 *
 * @param start - First page, 1-indexed.
 * @param end - Last page, 1-indexed, inclusive.
 * @param numPages - Number of pages in the document.
 * @return null if the range can be imported, otherwise why not.
 */
export function getPageRangeError(start: number, end: number, numPages: number): PageRangeError | null {
	if (!Number.isInteger(start) || start < 1 || start > numPages) {
		return { reason: 'start' }
	}
	if (!Number.isInteger(end) || end < start || end > numPages) {
		return { reason: 'end' }
	}
	const count = end - start + 1
	if (count > MAX_PDF_PAGES) {
		return { reason: 'tooManyPages', count }
	}
	return null
}
