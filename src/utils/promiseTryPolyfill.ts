/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Polyfills Promise.try, which pdfjs-dist uses unconditionally but not every
 * browser we support has yet. Must run in both the main thread and the PDF
 * worker, since they don't share globals.
 */
export function applyPromiseTryPolyfill(): void {
	if (typeof Promise.try === 'function') {
		return
	}

	Promise.try = function<T, U extends unknown[]>(callbackFn: (...args: U) => T | PromiseLike<T>, ...args: U): Promise<Awaited<T>> {
		return new Promise<Awaited<T>>((resolve) => {
			resolve(callbackFn(...args) as Awaited<T> | PromiseLike<Awaited<T>>)
		})
	}
}
