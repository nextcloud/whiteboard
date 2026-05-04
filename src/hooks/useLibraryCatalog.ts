/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import { useJWTStore } from '../stores/useJwtStore'
import { generateUrl } from '@nextcloud/router'
import type { LibraryItems } from '@excalidraw/excalidraw/types/types'
import logger from '../utils/logger'

export type LibraryScope = 'personal' | 'org'

export type LibraryEntry = { name: string; itemCount: number }

export type LibraryCatalog = { personal: LibraryEntry[]; org: LibraryEntry[] }

const authHeaders = (jwt: string) => ({
	'Content-Type': 'application/json',
	'X-Requested-With': 'XMLHttpRequest',
	Authorization: `Bearer ${jwt}`,
})

export function useLibraryCatalog() {
	const getJWT = useJWTStore(state => state.getJWT)

	const fetchLibraries = useCallback(async (): Promise<LibraryCatalog> => {
		const empty: LibraryCatalog = { personal: [], org: [] }
		try {
			const jwt = await getJWT()
			if (!jwt) {
				return empty
			}
			const response = await globalThis.fetch(generateUrl('apps/whiteboard/libraries'), {
				method: 'GET',
				headers: authHeaders(jwt),
			})
			if (!response.ok) {
				throw new Error(`Failed to list libraries: ${response.statusText}`)
			}
			const json = await response.json()
			const data = json?.data ?? {}
			return {
				personal: Array.isArray(data.personal) ? data.personal : [],
				org: Array.isArray(data.org) ? data.org : [],
			}
		} catch (error) {
			logger.error('[Library] Error listing libraries:', error)
			return empty
		}
	}, [getJWT])

	const resolveLibrary = useCallback(async (scope: string, name: string): Promise<LibraryItems> => {
		const jwt = await getJWT()
		if (!jwt) {
			return []
		}
		const url = `${generateUrl('apps/whiteboard/libraries/resolve')}?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`
		const response = await globalThis.fetch(url, {
			method: 'GET',
			headers: authHeaders(jwt),
		})
		if (!response.ok) {
			throw new Error(`Failed to resolve library: ${response.statusText}`)
		}
		const json = await response.json()
		return Array.isArray(json?.data) ? json.data : []
	}, [getJWT])

	const saveLibrary = useCallback(async (scope: LibraryScope, name: string, items: LibraryItems): Promise<void> => {
		const jwt = await getJWT()
		if (!jwt) {
			throw new Error('No JWT')
		}
		const response = await globalThis.fetch(generateUrl('apps/whiteboard/libraries'), {
			method: 'POST',
			headers: authHeaders(jwt),
			body: JSON.stringify({ scope, name, items }),
		})
		if (!response.ok) {
			const err = new Error(`Failed to save library: ${response.statusText}`) as Error & { status?: number }
			err.status = response.status
			throw err
		}
	}, [getJWT])

	const deleteLibrary = useCallback(async (scope: LibraryScope, name: string): Promise<void> => {
		const jwt = await getJWT()
		if (!jwt) {
			throw new Error('No JWT')
		}
		const url = `${generateUrl('apps/whiteboard/libraries')}/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`
		const response = await globalThis.fetch(url, {
			method: 'DELETE',
			headers: authHeaders(jwt),
		})
		if (!response.ok) {
			throw new Error(`Failed to delete library: ${response.statusText}`)
		}
	}, [getJWT])

	return { fetchLibraries, resolveLibrary, saveLibrary, deleteLibrary }
}
