/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useRef, useState } from 'react'
import { useJWTStore } from '../stores/useJwtStore'
import { useShallow } from 'zustand/react/shallow'
import { generateUrl } from '@nextcloud/router'
import type { LibraryItem, LibraryItems } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import logger from '../utils/logger'

type LibraryTemplate = {
	templateName: string
	items: LibraryItem[]
}

type LibraryItemContext = {
	templateName: string
}

type LibrarySaveError = Error & {
	status?: number
}

const PERSONAL_TEMPLATE = 'personal'
const BOARD_TEMPLATE = '__board_template__'
const VOLATILE_ELEMENT_KEYS = new Set([
	'id',
	'seed',
	'version',
	'versionNonce',
	'updated',
	'index',
	'groupIds',
	'frameId',
	'boundElements',
	'containerId',
])

function cleanLibraryItem(item: LibraryItem): LibraryItem {
	const cleanItem = { ...item } as LibraryItem & Record<string, unknown>
	delete cleanItem.templateName
	delete cleanItem.scope
	delete cleanItem.filename
	delete cleanItem.basename
	return cleanItem
}

function canonicalizeLibraryValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalizeLibraryValue)
	}
	if (value && typeof value === 'object') {
		const normalized: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (VOLATILE_ELEMENT_KEYS.has(key)) {
				continue
			}
			normalized[key] = canonicalizeLibraryValue((value as Record<string, unknown>)[key])
		}
		return normalized
	}
	return value
}

function getLibraryItemContentKey(item: LibraryItem): string {
	try {
		return JSON.stringify(canonicalizeLibraryValue(item.elements ?? []))
	} catch {
		return item.id || ''
	}
}

function dedupeLibraryItems(items: LibraryItems): LibraryItem[] {
	const deduped: LibraryItem[] = []
	const seen = new Set<string>()

	for (const item of items) {
		const key = getLibraryItemContentKey(item)
		if (!key || seen.has(key)) {
			continue
		}
		seen.add(key)
		deduped.push(cleanLibraryItem(item))
	}

	return deduped
}

function normalizeTemplates(responseData: unknown): LibraryTemplate[] {
	const templates = (responseData as { data?: { templates?: unknown } })?.data?.templates
	if (!Array.isArray(templates)) {
		return []
	}

	return templates
		.filter((template): template is { templateName: string; scope?: string; items: LibraryItem[] } => {
			const candidate = template as { templateName?: unknown; items?: unknown }
			return typeof candidate.templateName === 'string' && Array.isArray(candidate.items)
		})
		.map(template => ({
			templateName: template.templateName,
			items: template.items,
		}))
}

function updateItemContextMap(templates: LibraryTemplate[], itemContexts: Map<string, LibraryItemContext>) {
	for (const template of templates) {
		for (const item of template.items) {
			if (!item.id) {
				continue
			}
			const existing = itemContexts.get(item.id)
			if (existing?.templateName === PERSONAL_TEMPLATE && template.templateName !== PERSONAL_TEMPLATE) {
				continue
			}
			if (existing && existing.templateName !== PERSONAL_TEMPLATE && template.templateName !== PERSONAL_TEMPLATE) {
				continue
			}
			itemContexts.set(item.id, {
				templateName: template.templateName,
			})
		}
	}
}

export function useLibrary() {
	const { getJWT } = useJWTStore(
		useShallow(state => ({
			getJWT: state.getJWT,
		})),
	)

	const [isLibraryLoaded, setIsLibraryLoaded] = useState(false)
	const itemContextsRef = useRef<Map<string, LibraryItemContext>>(new Map())

	const fetchLibraryItems = useCallback(async (): Promise<LibraryItems | null> => {
		try {
			const jwt = await getJWT()
			if (!jwt) {
				logger.warn('[Library] No JWT found, cannot fetch library')
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
			const templates = normalizeTemplates(data)
			const personalTemplates = templates.filter(template => template.templateName.toLowerCase() === PERSONAL_TEMPLATE)
			const personalItems = dedupeLibraryItems(personalTemplates.flatMap(template => template.items))
			const itemContexts = new Map<string, LibraryItemContext>()
			updateItemContextMap([{
				templateName: PERSONAL_TEMPLATE,
				items: personalItems,
			}], itemContexts)
			itemContextsRef.current = itemContexts

			return personalItems
		} catch (error) {
			logger.error('[Library] Error fetching library:', error)
			return null
		}
	}, [getJWT])

	const mergeInitialLibraryItems = useCallback((personalItems: LibraryItems, currentItems: LibraryItems, useBoardLibrary = false): LibraryItems => {
		const merged: LibraryItem[] = []
		const seen = new Set<string>()
		const nextContexts = new Map<string, LibraryItemContext>()

		if (useBoardLibrary) {
			for (const item of dedupeLibraryItems(currentItems)) {
				const key = getLibraryItemContentKey(item)
				if (!key || seen.has(key)) {
					continue
				}
				seen.add(key)
				merged.push(item)
				if (item.id) {
					nextContexts.set(item.id, { templateName: BOARD_TEMPLATE })
				}
			}
			itemContextsRef.current = nextContexts
			return merged
		}

		for (const item of dedupeLibraryItems(personalItems)) {
			const key = getLibraryItemContentKey(item)
			seen.add(key)
			merged.push(item)
			if (item.id) {
				nextContexts.set(item.id, { templateName: PERSONAL_TEMPLATE })
			}
		}

		for (const item of dedupeLibraryItems(currentItems)) {
			const key = getLibraryItemContentKey(item)
			if (!key || seen.has(key)) {
				continue
			}
			seen.add(key)
			merged.push(item)
			if (item.id) {
				nextContexts.set(item.id, { templateName: BOARD_TEMPLATE })
			}
		}

		itemContextsRef.current = nextContexts
		return merged
	}, [])

	const updateLibraryItems = useCallback(async (items: LibraryItems, boardFileId?: number | null, useBoardLibrary = false): Promise<void> => {
		try {
			const jwt = await getJWT()
			if (!jwt) {
				logger.warn('[Library] No JWT found, cannot update library')
				return
			}

			if (useBoardLibrary && boardFileId) {
				const boardItems = dedupeLibraryItems(items)
				const url = generateUrl(`apps/whiteboard/${boardFileId}`)
				const response = await globalThis.fetch(url, {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						'X-Requested-With': 'XMLHttpRequest',
						Authorization: `Bearer ${jwt}`,
					},
					body: JSON.stringify({
						data: {
							libraryItems: boardItems,
						},
					}),
				})

				if (!response.ok) {
					throw new Error(`Failed to update board library: ${response.statusText}`)
				}

				const nextContexts = new Map<string, LibraryItemContext>()
				updateItemContextMap([{
					templateName: BOARD_TEMPLATE,
					items: boardItems,
				}], nextContexts)
				itemContextsRef.current = nextContexts
				return
			}

			const personalItems: LibraryItem[] = []
			const seen = new Set<string>()
			for (const item of items) {
				const context = item.id ? itemContextsRef.current.get(item.id) : undefined
				if (context && context.templateName !== PERSONAL_TEMPLATE) {
					continue
				}
				const cleanItem = cleanLibraryItem(item)
				const key = getLibraryItemContentKey(cleanItem)
				if (!key || seen.has(key)) {
					continue
				}
				seen.add(key)
				personalItems.push(cleanItem)
			}

			const templates = [{
				templateName: PERSONAL_TEMPLATE,
				items: personalItems,
			}]

			const url = generateUrl('apps/whiteboard/library')
			const response = await globalThis.fetch(url, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({ templates }),
			})

			if (!response.ok) {
				throw new Error(`Failed to update library: ${response.statusText}`)
			}

			const nextContexts = new Map<string, LibraryItemContext>(
				Array.from(itemContextsRef.current.entries()).filter(([, context]) => context.templateName !== PERSONAL_TEMPLATE),
			)
			updateItemContextMap(templates.map(template => ({
				templateName: template.templateName,
				items: template.items,
			})), nextContexts)
			itemContextsRef.current = nextContexts
		} catch (error) {
			logger.error('[Library] Error updating library:', error)
		}
	}, [getJWT])

	const saveLibraryTemplate = useCallback(async (templateName: string, items: LibraryItems): Promise<void> => {
		const jwt = await getJWT()
		if (!jwt) {
			logger.warn('[Library] No JWT found, cannot save library template')
			return
		}

		const url = generateUrl('apps/whiteboard/library/template')
		const response = await globalThis.fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				Authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({
				templateName,
				items: items.map(cleanLibraryItem),
			}),
		})

		if (!response.ok) {
			const error = new Error(`Failed to save library template: ${response.statusText}`) as LibrarySaveError
			error.status = response.status
			throw error
		}
	}, [getJWT])

	return {
		fetchLibraryItems,
		mergeInitialLibraryItems,
		updateLibraryItems,
		saveLibraryTemplate,
		isLibraryLoaded,
		setIsLibraryLoaded,
	}
}
