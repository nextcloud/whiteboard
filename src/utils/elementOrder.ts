/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type Stamped = { version: number, versionNonce: number }

/**
 * Whether copy `a` of an element replaces copy `b`, by Excalidraw's order:
 * a higher version wins; on equal versions the lower nonce wins. Nextcloud
 * merges saves by the same order.
 */
export function wins(a: Stamped, b: Stamped): boolean {
	return a.version !== b.version ? a.version > b.version : a.versionNonce < b.versionNonce
}

export function sameStamp(a: Stamped, b: Stamped): boolean {
	return a.version === b.version && a.versionNonce === b.versionNonce
}

/**
 * The elements in fractional index order. Excalidraw's restore gives an
 * element out of this order a new index and a new version, so elements from
 * the server or the room are restored in it.
 */
export function inIndexOrder<T extends { id: string, index?: string | null }>(elements: readonly T[]): T[] {
	return [...elements].sort((a, b) => {
		if (typeof a.index !== 'string' || typeof b.index !== 'string') {
			return 0
		}
		if (a.index !== b.index) {
			return a.index < b.index ? -1 : 1
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	})
}
