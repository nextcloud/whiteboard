/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nextcloud/auth', () => ({ getRequestToken: () => 'token' }))

const { restoreDestination, restoreThroughNextcloud } = await import('../../src/utils/versionRestore.ts')

describe('restoring a version through Nextcloud', () => {
	afterEach(() => {
		delete globalThis.fetch
	})

	it('moves a version to the restore target of its user, as Files does', () => {
		expect(restoreDestination('/remote.php/dav/versions/alice/versions/123/1730000000')).toBe(`${window.location.origin}/remote.php/dav/versions/alice/restore/target`)
		expect(restoreDestination('https://cloud.example/nc/remote.php/dav/versions/bob/versions/7/42')).toBe('https://cloud.example/nc/remote.php/dav/versions/bob/restore/target')
	})

	it('moves a deleted file to the restore folder of the trash', () => {
		expect(restoreDestination('/remote.php/dav/trashbin/alice/trash/Board.whiteboard.d1730000000')).toBe(`${window.location.origin}/remote.php/dav/trashbin/alice/restore/Board.whiteboard.d1730000000`)
	})

	it('knows nothing to restore for other sources', () => {
		expect(restoreDestination('/index.php/apps/files')).toBeNull()
	})

	it('sends the move with the request token and fails when Nextcloud refuses it', async () => {
		globalThis.fetch = vi.fn(async () => new Response(null, { status: 201 }))
		await restoreThroughNextcloud('/remote.php/dav/versions/alice/versions/123/1730000000')

		const [url, init] = globalThis.fetch.mock.calls[0]
		expect(String(url)).toBe(`${window.location.origin}/remote.php/dav/versions/alice/versions/123/1730000000`)
		expect(init).toMatchObject({ method: 'MOVE', headers: { Destination: `${window.location.origin}/remote.php/dav/versions/alice/restore/target`, requesttoken: 'token' } })

		globalThis.fetch = vi.fn(async () => new Response(null, { status: 403 }))
		await expect(restoreThroughNextcloud('/remote.php/dav/versions/alice/versions/123/1')).rejects.toThrow('403')
	})
})
