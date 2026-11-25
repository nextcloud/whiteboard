/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadState } from '@nextcloud/initial-state'

/**
 * Total image size one PDF import may add, split evenly across its pages.
 * Every save writes the whole board, images included.
 */
export const IMPORT_TOTAL_BUDGET_BYTES = 20 * 1024 * 1024

/** Which limit sets a page's target size. */
export type PageSizeLimit = 'admin' | 'collab' | 'importBudget'

export interface PageSizeTarget {
	bytes: number
	limit: PageSizeLimit
}

export interface ImportedPageSize {
	pageNumber: number
	byteSize: number
}

export interface ImportSizeReport {
	/** Pages over the hard limit, which are not imported, in page order. */
	skippedPages: ImportedPageSize[]
	/** Pages within the hard limit but still over the target, in page order. */
	oversizedPages: ImportedPageSize[]
	/** Size of the pages that are imported. */
	totalBytes: number
}

/**
 * The admin's maximum image size, in bytes, as App.tsx reads it, or null if
 * it isn't a positive number.
 */
export function getMaxImageSizeBytes(): number | null {
	const maxImageSizeMb = Number(loadState('whiteboard', 'maxFileSize', 10))
	if (!Number.isFinite(maxImageSizeMb) || maxImageSizeMb <= 0) {
		return null
	}
	return maxImageSizeMb * 1024 * 1024
}

/**
 * Size each page of an import is compressed to fit: the smallest of the
 * admin's maximum image size, the largest file the collaboration server
 * passes on and an even share of IMPORT_TOTAL_BUDGET_BYTES. On a tie, the
 * earlier one is named.
 *
 * @param maxImageSizeBytes - The admin's maximum image size, or null for none.
 * @param sharedFileBytes - The largest file the collaboration server passes
 *   on, from currentLargestSharedFileBytes.
 * @param pageCount - Number of pages being imported.
 */
export function getPageSizeTarget(maxImageSizeBytes: number | null, sharedFileBytes: number, pageCount: number): PageSizeTarget {
	const candidates: PageSizeTarget[] = [
		getPageSizeLimit(maxImageSizeBytes, sharedFileBytes),
		{ bytes: Math.floor(IMPORT_TOTAL_BUDGET_BYTES / Math.max(pageCount, 1)), limit: 'importBudget' },
	]
	return candidates.reduce((smallest, candidate) => (candidate.bytes < smallest.bytes ? candidate : smallest))
}

/**
 * Size above which a page is not imported: the smaller of the admin's
 * maximum image size, which regular images are refused above, and the
 * largest file the collaboration server passes on, which the others in the
 * board would not receive. On a tie, the admin's limit is named.
 *
 * @param maxImageSizeBytes - The admin's maximum image size, or null for none.
 * @param sharedFileBytes - The largest file the collaboration server passes
 *   on, from currentLargestSharedFileBytes.
 */
export function getPageSizeLimit(maxImageSizeBytes: number | null, sharedFileBytes: number): PageSizeTarget {
	if (maxImageSizeBytes !== null && maxImageSizeBytes <= sharedFileBytes) {
		return { bytes: maxImageSizeBytes, limit: 'admin' }
	}
	return { bytes: sharedFileBytes, limit: 'collab' }
}

/**
 * Splits rendered pages into those over the hard limit, which are skipped,
 * and those that are imported, noting which of them missed their target.
 *
 * @param pages - The rendered pages.
 * @param targetBytes - The target size from getPageSizeTarget.
 * @param limitBytes - The hard limit from getPageSizeLimit.
 */
export function getImportSizeReport(pages: ImportedPageSize[], targetBytes: number, limitBytes: number): ImportSizeReport {
	const toSize = ({ pageNumber, byteSize }: ImportedPageSize): ImportedPageSize => ({ pageNumber, byteSize })
	const imported = pages.filter((page) => page.byteSize <= limitBytes)
	return {
		skippedPages: pages.filter((page) => page.byteSize > limitBytes).map(toSize),
		oversizedPages: imported.filter((page) => page.byteSize > targetBytes).map(toSize),
		totalBytes: imported.reduce((sum, page) => sum + page.byteSize, 0),
	}
}

/**
 * Formats a size in MB the way the admin setting counts them (1024 × 1024
 * bytes), with at most two decimals, enough to tell a page apart from a
 * per-page share of the import budget.
 *
 * @param bytes - Size in bytes.
 */
export function formatMegabytes(bytes: number): string {
	return String(Number((bytes / 1024 / 1024).toFixed(2)))
}
