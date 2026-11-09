/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import 'fake-indexeddb/auto'

const { localBoardStore } = await import('../../src/sync/localBoardStore.ts')

const box = (id, version) => ({ id, type: 'rectangle', version, versionNonce: version })
const image = { id: 'img', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png' }

describe('localBoardStore', () => {
	beforeEach(async () => {
		vi.useRealTimers()
		await Promise.all([localBoardStore.outbox.clear(), localBoardStore.recovery.clear()])
	})

	it('keeps an unsaved image of an earlier epoch for recovery, even without its element', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [], files: { img: image } })

		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(true)

		const recovered = await localBoardStore.recovered('alice', 1)
		expect(recovered.files.img.dataURL).toBe(image.dataURL)
		expect(await localBoardStore.outbox.count()).toBe(0)
	})

	it('keeps recovered changes for 30 days unless they are dropped', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [box('a', 3)], files: {} })
		await localBoardStore.setAside('alice', 1, 'e2')
		await localBoardStore.recovery.toCollection().modify({ setAsideAt: Date.now() - 29 * 24 * 3600 * 1000 })

		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(true)
		const recovered = await localBoardStore.recovered('alice', 1)
		expect(recovered.elements.map((element) => element.id)).toEqual(['a'])

		await localBoardStore.dropRecovered(recovered.keys)
		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(false)
	})

	it('drops recovered changes older than 30 days', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [box('a', 3)], files: {} })
		await localBoardStore.setAside('alice', 1, 'e2')
		await localBoardStore.recovery.toCollection().modify({ setAsideAt: Date.now() - 31 * 24 * 3600 * 1000 })

		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(false)
		expect((await localBoardStore.recovered('alice', 1)).elements).toEqual([])
		expect(await localBoardStore.recovery.count()).toBe(0)
	})

	it('gives back the changes of the current epoch that a tab still on an older one moved to recovery', async () => {
		// Another tab kept an edit of the restored board (e2); this tab still believed in e1
		await localBoardStore.keep('alice', 1, 'e2', { elements: [box('final-edit', 1)], files: {} })
		await localBoardStore.setAside('alice', 1, 'e1')

		const kept = await localBoardStore.claimKept('alice', 1, 'e2')

		expect(kept.elements.map((element) => element.id)).toEqual(['final-edit'])
		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(false)
	})

	it('gives back the unsaved board settings of the current epoch that a tab still on an older one moved to recovery', async () => {
		await localBoardStore.keep('alice', 1, 'e2', { elements: [box('a', 2)], files: {}, settings: { viewBackgroundColor: '#ff0000' } })
		await localBoardStore.setAside('alice', 1, 'e1')

		const kept = await localBoardStore.claimKept('alice', 1, 'e2')

		expect(kept.settings).toEqual({ viewBackgroundColor: '#ff0000' })
		expect((await localBoardStore.recovered('alice', 1)).keys).toEqual([])
	})

	it('tells whether this device keeps changes of an account that Nextcloud does not have', async () => {
		expect(await localBoardStore.keepsChanges('alice')).toBe(false)
		await localBoardStore.keep('alice', 7, 'e1', { elements: [box('a', 2)], files: {} })
		expect(await localBoardStore.keepsChanges('alice')).toBe(true)
		expect(await localBoardStore.keepsChanges('bob')).toBe(false)

		// Set aside for recovery, still on the device
		await localBoardStore.setAside('alice', 7, 'e2')

		expect(await localBoardStore.keepsChanges('alice')).toBe(true)
	})

	it('lets each board setting go on its own once Nextcloud has its value', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [], files: {}, settings: { viewBackgroundColor: '#ffff00', gridSize: 30 } })
		// The grid changed again while yellow and 30 were on their way
		await localBoardStore.keep('alice', 1, 'e1', { elements: [], files: {}, settings: { gridSize: 40 } })

		await localBoardStore.dropSaved('alice', 1, 'e1', { elements: new Map(), files: new Set(), settings: { viewBackgroundColor: '#ffff00', gridSize: 30 } })

		expect((await localBoardStore.claimKept('alice', 1, 'e1')).settings).toEqual({ gridSize: 40 })
	})

	it('also drops saved changes that another tab moved to recovery meanwhile', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [box('a', 2), box('b', 2)], files: {} })
		// Another tab of this browser saw the board change epoch
		await localBoardStore.setAside('alice', 1, 'e2')

		// The closing save of e1 brought a@2 to Nextcloud
		await localBoardStore.dropSaved('alice', 1, 'e1', { elements: new Map([['a', box('a', 2)]]), files: new Set(), settings: {} })

		expect((await localBoardStore.recovered('alice', 1)).elements.map((element) => element.id)).toEqual(['b'])
	})

	it('keeps unsaved board settings for recovery', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [], files: {}, settings: { viewBackgroundColor: '#0000ff' } })

		expect(await localBoardStore.setAside('alice', 1, 'e2')).toBe(true)

		expect((await localBoardStore.recovered('alice', 1)).settings).toEqual({ viewBackgroundColor: '#0000ff' })
	})

	it('keeps the changes of each account and board apart', async () => {
		await localBoardStore.keep('alice', 1, 'e1', { elements: [box('a', 1)], files: {} })
		await localBoardStore.keep('bob', 1, 'e1', { elements: [box('b', 1)], files: {} })
		await localBoardStore.keep('alice', 2, 'e1', { elements: [box('c', 1)], files: {} })

		expect((await localBoardStore.claimKept('alice', 1, 'e1')).elements.map((element) => element.id)).toEqual(['a'])
	})
})
