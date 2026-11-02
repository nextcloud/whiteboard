/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { BinaryFiles } from '@nextcloud/excalidraw/types'

import { SCENE_SCHEMA_VERSION } from './sceneSchema.ts'

// Browsers reject keepalive requests above 64 KiB
const KEEPALIVE_BODY_LIMIT = 64 * 1024

export async function saveSceneOnUnload(url: string, jwt: string, elements: readonly ExcalidrawElement[], files: BinaryFiles): Promise<boolean> {
	const body = new Blob([JSON.stringify({ data: { elements, files }, schemaVersion: SCENE_SCHEMA_VERSION })])
	if (body.size > KEEPALIVE_BODY_LIMIT) {
		return false
	}

	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			Authorization: `Bearer ${jwt}`,
		},
		body,
		keepalive: true,
	})
	return response.ok
}
