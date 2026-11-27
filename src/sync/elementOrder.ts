/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isEqual, omit } from 'lodash'

type Stamped = { version: number, versionNonce: number }

const STAMP_KEYS = ['version', 'versionNonce', 'updated']

// A safe integer, from a number or a string of digits
function safeInteger(value: unknown): number | undefined {
	const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
	return Number.isSafeInteger(number) ? number as number : undefined
}

// As Excalidraw restores stamps, but always integers, as Nextcloud reads them
const version = (value: unknown): number => Math.max(safeInteger(value) ?? 1, 1)
const nonce = (value: unknown): number => safeInteger(value) ?? 0

/**
 * The element with integer stamps, for an element of a board another tool
 * wrote: Excalidraw would keep a version "7" and make an edit of it "71"
 *
 * @param element
 */
export function withIntegerStamps<T extends Stamped>(element: T): T {
	return { ...element, version: version(element.version), versionNonce: nonce(element.versionNonce) }
}

/**
 * Whether copy `a` of an element replaces copy `b`, by Excalidraw's order:
 * a higher version wins; on equal versions the lower nonce wins. Nextcloud
 * merges saves by the same order.
 */
export function wins(a: Stamped, b: Stamped): boolean {
	const [aVersion, bVersion] = [version(a.version), version(b.version)]
	return aVersion !== bVersion ? aVersion > bVersion : nonce(a.versionNonce) < nonce(b.versionNonce)
}

/** Whether two copies have the same stamp, counted as `wins` counts it */
export function sameStamp(a: Stamped, b: Stamped): boolean {
	return version(a.version) === version(b.version) && nonce(a.versionNonce) === nonce(b.versionNonce)
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
