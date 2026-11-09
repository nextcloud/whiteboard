/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getRequestToken } from '@nextcloud/auth'

/**
 * Whether a WebDAV URL is a version or a deleted file, which never changes
 *
 * @param source WebDAV URL
 */
export function isStoredCopy(source: string): boolean {
	return source.includes('/dav/versions/') || source.includes('/dav/trashbin/')
}

/**
 * Where Files moves a version, or a deleted file, so Nextcloud restores it
 *
 * @param source WebDAV URL of a version (`…/dav/versions/<user>/versions/<file id>/<version>`) or of a deleted file (`…/dav/trashbin/<user>/trash/<name>`)
 */
export function restoreDestination(source: string): string | null {
	const url = new URL(source, window.location.href)
	const version = url.pathname.match(/^(.*\/dav\/versions\/[^/]+)\/versions\/[^/]+\/[^/]+$/)
	if (version) {
		return `${url.origin}${version[1]}/restore/target`
	}
	const deleted = url.pathname.match(/^(.*\/dav\/trashbin\/[^/]+)\/trash\/([^/]+)$/)
	return deleted ? `${url.origin}${deleted[1]}/restore/${deleted[2]}` : null
}

/**
 * Has Nextcloud restore a version as Files does, so it keeps the file's
 * history, sends its restore events and adds the activity
 *
 * @param source WebDAV URL of the version
 */
export async function restoreThroughNextcloud(source: string): Promise<void> {
	const destination = restoreDestination(source)
	if (!destination) {
		throw new Error('Not a version of a file')
	}
	const response = await fetch(new URL(source, window.location.href), {
		method: 'MOVE',
		credentials: 'include',
		headers: { Destination: destination, requesttoken: getRequestToken() ?? '' },
	})
	if (!response.ok) {
		throw new Error(`Could not restore the version (${response.status})`)
	}
}
