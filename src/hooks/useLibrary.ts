/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback } from 'react'
import { useJWTStore } from '../stores/useJwtStore'
import { useShallow } from 'zustand/react/shallow'
import { generateUrl } from '@nextcloud/router'
import type { LibraryItem, LibraryItems } from '@excalidraw/excalidraw/types/types'

type LibraryItemExtended = LibraryItem & {
	filename?: string;
}

export function useLibrary() {
	const { getJWT } = useJWTStore(
		useShallow(state => ({
			getJWT: state.getJWT,
		})),
	)

	const fetchLibraryItems = useCallback(async (): Promise<LibraryItems | null> => {
		try {
			const jwt = await getJWT()
			if (!jwt) {
				console.warn('[Library] No JWT found, cannot fetch library')
				return null
			}
			const url = generateUrl('apps/whiteboard/library')
			const response = await globalThis.fetch(url, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${jwt}`,
				},
			})

			if (!response.ok) {
				throw new Error(`Failed to fetch library: ${response.statusText}`)
			}

			const data = await response.json()
			const libraryItems: LibraryItems = []

			for (const file of data.data) {
				if (!file.library && !file.libraryItems) {
					console.warn('[Library] No valid library data found for file:', file)
					continue
				}

				const date = new Date()

				// Handle for version 1 (legacy library files from https://excalidraw.com)
				if (file.library) {
					for (const elements of file.library) {
						const item: LibraryItemExtended = {
							id: '',
							created: date.getTime(),
							status: 'published',
							elements,
							filename: file.filename,
						}
						libraryItems.push(item)
					}
				}

				// Handle for version 2
				if (file.libraryItems) {
					for (const item of file.libraryItems) {
						if (!item.elements || item.elements.length === 0) {
							console.warn('[Library] Skipping item with no elements:', item)
							continue
						}
						const libraryItem: LibraryItemExtended = {
							id: item.id,
							created: item.created || date.getTime(),
							status: item.status || 'unpublished',
							elements: item.elements,
							filename: file.filename,
						}
						libraryItems.push(libraryItem)
					}
				}
			}
			return libraryItems
		} catch (error) {
			console.error('[Library] Error fetching library:', error)
			return null
		}
	})

	const updateLibraryItems = useCallback(async (items: LibraryItems): Promise<void> => {
		try {
			const jwt = await getJWT()
			if (!jwt) {
				console.warn('[Library] No JWT found, cannot update library')
				return
			}
			const url = generateUrl('apps/whiteboard/library')
			const response = await globalThis.fetch(url, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({ items }),
			})

			if (!response.ok) {
				throw new Error(`Failed to update library: ${response.statusText}`)
			}
		} catch (error) {
			console.error('[Library] Error updating library:', error)
		}
	})

	return {
		fetchLibraryItems,
		updateLibraryItems,
	}
}
