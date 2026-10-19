/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LibraryItems } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { LibraryEntry } from '../hooks/useLibraryCatalog.ts'
import type { LibraryRef } from '../stores/useWhiteboardConfigStore.ts'

import logger from './logger.ts'

export async function resolveOrgLibraryItems(
	libraries: LibraryEntry[],
	libraryRef: LibraryRef | null,
	resolveLibrary: (scope: string, name: string) => Promise<LibraryItems>,
): Promise<LibraryItems> {
	const results = await Promise.allSettled(libraries
		.filter(({ name }) => libraryRef?.scope !== 'org' || libraryRef.name !== name)
		.map(({ name }) => resolveLibrary('org', name)))

	return results.flatMap((result) => {
		if (result.status === 'fulfilled') {
			return result.value
		}
		logger.error('[Library] Error resolving organization library:', result.reason)
		return []
	})
}
