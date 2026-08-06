/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWhiteboardSnapshot } from '../../src/utils/fetchWhiteboardSnapshot.ts'

vi.mock('@nextcloud/router', () => ({
	generateUrl: (path) => `/index.php/${path}`,
}))

describe('scene restore', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('loads the authoritative restored snapshot from Nextcloud', async () => {
		const snapshot = {
			elements: [{
				id: 'legacy-element',
				customData: {
					creator: { uid: 'alice', displayName: 'Alice', createdAt: 1 },
				},
			}],
			files: {},
		}
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: snapshot }),
		})
		vi.stubGlobal('fetch', fetchMock)

		await expect(fetchWhiteboardSnapshot(123, 'jwt')).resolves.toEqual(snapshot)
		expect(fetchMock).toHaveBeenCalledWith('/index.php/apps/whiteboard/123', {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				Authorization: 'Bearer jwt',
			},
		})
	})

	it('rejects a response without scene elements', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: { files: {} } }),
		}))

		await expect(fetchWhiteboardSnapshot(123, 'jwt')).rejects.toThrow('Invalid whiteboard snapshot')
	})
})
