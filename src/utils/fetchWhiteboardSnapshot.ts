/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { generateUrl } from '@nextcloud/router'

export type WhiteboardSnapshot = {
	elements: unknown[]
	files?: unknown
	appState?: unknown
	scrollToContent?: boolean
}

export async function fetchWhiteboardSnapshot(fileId: number, jwt: string): Promise<WhiteboardSnapshot> {
	const response = await fetch(generateUrl(`apps/whiteboard/${fileId}`), {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			Authorization: `Bearer ${jwt}`,
		},
	})

	if (!response.ok) {
		throw new Error(`Unexpected status ${response.status}`)
	}

	const responseData: unknown = await response.json()
	if (!responseData || typeof responseData !== 'object' || !('data' in responseData)) {
		throw new Error('Invalid whiteboard response')
	}

	const snapshot = responseData.data
	if (!snapshot || typeof snapshot !== 'object' || !('elements' in snapshot) || !Array.isArray(snapshot.elements)) {
		throw new Error('Invalid whiteboard snapshot')
	}

	return snapshot as WhiteboardSnapshot
}
