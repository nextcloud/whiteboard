/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isEqual, omit } from 'lodash'

type Stamped = { version: number, versionNonce: number }

const STAMP_KEYS = ['version', 'versionNonce', 'updated']

// A stamp a board written by another tool may lack counts as 0, as Nextcloud counts it
const stamp = (value: unknown): number => Number.isInteger(value) ? value as number : 0

/**
 * Whether copy `a` of an element replaces copy `b`, by Excalidraw's order:
 * a higher version wins; on equal versions the lower nonce wins. Nextcloud
 * merges saves by the same order.
 */
export function wins(a: Stamped, b: Stamped): boolean {
	const [version, otherVersion] = [stamp(a.version), stamp(b.version)]
	return version !== otherVersion ? version > otherVersion : stamp(a.versionNonce) < stamp(b.versionNonce)
}

/** Whether two copies have the same stamp, counted as `wins` counts it */
export function sameStamp(a: Stamped, b: Stamped): boolean {
	return stamp(a.version) === stamp(b.version) && stamp(a.versionNonce) === stamp(b.versionNonce)
}

/** Whether two copies of an element look the same, whatever their stamps */
export function sameContent(a: Stamped, b: Stamped): boolean {
	return isEqual(omit(a, STAMP_KEYS), omit(b, STAMP_KEYS))
}

/**
 * The elements in fractional index order. Excalidraw's restore gives an
 * element out of this order a new index and a new version, so elements from
 * the server or the room are restored in it. As on Nextcloud, elements of
 * which one has no index keep their order.
 */
export function inIndexOrder<T extends { id: string, index?: string | null }>(elements: readonly T[]): T[] {
	if (elements.some((element) => typeof element.index !== 'string')) {
		return [...elements]
	}
	return [...elements].sort((a, b) => {
		if (a.index !== b.index) {
			return (a.index as string) < (b.index as string) ? -1 : 1
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	})
}
