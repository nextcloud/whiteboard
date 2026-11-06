/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import 'fake-indexeddb/auto'

const { localBoardStore } = await import('../../src/database/localBoardStore.ts')

const box = (id, version) => ({ id, type: 'rectangle', version, versionNonce: version })
const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }

describe('localBoardStore', () => {
	beforeEach(async () => {
		vi.useRealTimers()
		await Promise.all([localBoardStore.outbox.clear(), localBoardStore.recovery.clear()])
	})

	it('keeps an unsaved image of an earlier epoch for recovery, even without its element', async () => {
		await localBoardStore.keep('alice', 1, 'e1', [], { img: image })

		expect(await localBoardStore.recover('alice', 1, 'e2')).toBe(true)

		const recovered = await localBoardStore.recovered('alice', 1)
		expect(recovered.files.img.dataURL).toBe(image.dataURL)
		expect(await localBoardStore.outbox.count()).toBe(0)
	})

	it('keeps recovered changes until they are dropped, however old they are', async () => {
		await localBoardStore.keep('alice', 1, 'e1', [box('a', 3)], {})
		await localBoardStore.recover('alice', 1, 'e2')
		await localBoardStore.recovery.toCollection().modify({ savedAt: Date.now() - 365 * 24 * 3600 * 1000 })

		expect(await localBoardStore.recover('alice', 1, 'e2')).toBe(true)
		const recovered = await localBoardStore.recovered('alice', 1)
		expect(recovered.elements.map((element) => element.id)).toEqual(['a'])

		await localBoardStore.dropRecovered(recovered.keys)
		expect(await localBoardStore.recover('alice', 1, 'e2')).toBe(false)
	})

	it('gives back the changes of the current epoch that a tab still on an older one moved to recovery', async () => {
		// Another tab kept an edit of the restored board (e2); this tab still believed in e1
		await localBoardStore.keep('alice', 1, 'e2', [box('final-edit', 1)], {})
		await localBoardStore.recover('alice', 1, 'e1')

		const kept = await localBoardStore.kept('alice', 1, 'e2')

		expect(kept.elements.map((element) => element.id)).toEqual(['final-edit'])
		expect(await localBoardStore.recover('alice', 1, 'e2')).toBe(false)
	})

	it('keeps the changes of each account and board apart', async () => {
		await localBoardStore.keep('alice', 1, 'e1', [box('a', 1)], {})
		await localBoardStore.keep('bob', 1, 'e1', [box('b', 1)], {})
		await localBoardStore.keep('alice', 2, 'e1', [box('c', 1)], {})

		expect((await localBoardStore.kept('alice', 1, 'e1')).elements.map((element) => element.id)).toEqual(['a'])
	})
})
