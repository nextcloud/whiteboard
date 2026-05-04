/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import { useJWTStore } from '../stores/useJwtStore'
import { generateUrl } from '@nextcloud/router'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'

export interface CanvasTemplateData {
	elements: readonly unknown[]
	files: BinaryFiles
	appState?: Record<string, unknown>
}

export function useCanvasTemplate() {
	const getJWT = useJWTStore(state => state.getJWT)

	const publishCanvasTemplate = useCallback(async (scope: 'personal' | 'org', name: string, data: CanvasTemplateData): Promise<void> => {
		const jwt = await getJWT()
		if (!jwt) {
			throw new Error('No JWT')
		}
		const response = await globalThis.fetch(generateUrl('apps/whiteboard/canvas-template'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				Authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({ scope, name, data }),
		})
		if (!response.ok) {
			const err = new Error(`Failed to publish template: ${response.statusText}`) as Error & { status?: number }
			err.status = response.status
			throw err
		}
	}, [getJWT])

	return { publishCanvasTemplate }
}
