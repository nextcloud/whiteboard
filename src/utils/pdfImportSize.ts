/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadState } from '@nextcloud/initial-state'
import { MAX_SOCKET_PAGE_BYTES } from './pdfToImages.ts'

/**
 * Total image size one PDF import may add, split evenly across its pages.
 * Every save writes the whole board, images included.
 */
export const IMPORT_TOTAL_BUDGET_BYTES = 20 * 1024 * 1024

/** Which limit sets a page's target size. */
export type PageSizeLimit = 'admin' | 'socket' | 'importBudget'

export interface PageSizeTarget {
	bytes: number
	limit: PageSizeLimit
}

export interface ImportedPageSize {
	pageNumber: number
	byteSize: number
}

export interface ImportSizeReport {
	/** Pages still larger than the target, in page order. */
	oversizedPages: ImportedPageSize[]
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
 * admin's maximum image size, the collab server's message limit and an even
 * share of IMPORT_TOTAL_BUDGET_BYTES. On a tie, the earlier one is named.
 *
 * @param maxImageSizeBytes - The admin's maximum image size, or null for none.
 * @param pageCount - Number of pages being imported.
 */
export function getPageSizeTarget(maxImageSizeBytes: number | null, pageCount: number): PageSizeTarget {
	const candidates: PageSizeTarget[] = [
		...(maxImageSizeBytes === null ? [] : [{ bytes: maxImageSizeBytes, limit: 'admin' as const }]),
		{ bytes: MAX_SOCKET_PAGE_BYTES, limit: 'socket' },
		{ bytes: Math.floor(IMPORT_TOTAL_BUDGET_BYTES / Math.max(pageCount, 1)), limit: 'importBudget' },
	]
	return candidates.reduce((smallest, candidate) => (candidate.bytes < smallest.bytes ? candidate : smallest))
}

/**
 * Which imported pages are still over their target size.
 *
 * @param pages - The imported pages.
 * @param targetBytes - The target size from getPageSizeTarget.
 */
export function getImportSizeReport(pages: ImportedPageSize[], targetBytes: number): ImportSizeReport {
	return {
		oversizedPages: pages.filter((page) => page.byteSize > targetBytes).map(({ pageNumber, byteSize }) => ({ pageNumber, byteSize })),
		totalBytes: pages.reduce((sum, page) => sum + page.byteSize, 0),
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
