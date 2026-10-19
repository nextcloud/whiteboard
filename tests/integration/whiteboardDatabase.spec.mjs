/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import { WhiteboardDatabase } from '../../src/database/db.ts'
import { computeElementVersionHash, computeSceneKey } from '../../src/utils/syncSceneData.ts'

WhiteboardDatabase.dependencies.indexedDB = new IDBFactory()
WhiteboardDatabase.dependencies.IDBKeyRange = IDBKeyRange

const scene = (version) => [{ id: 'A', version, versionNonce: version }]
const isScene = (elements, files) => (stored) => computeSceneKey(stored.elements, stored.files) === computeSceneKey(elements, files)

describe('marking an upload as saved', () => {
	const connections = []
	const open = () => {
		const connection = new WhiteboardDatabase()
		connections.push(connection)
		return connection
	}

	afterEach(async () => {
		await connections[0]?.clear()
		connections.splice(0).forEach((connection) => connection.close())
	})

	it('reads and writes the board in one transaction, so no other tab can write in between', async () => {
		const tab = open()
		await tab.put(1, scene(1), {}, undefined, { hasPendingLocalChanges: false })
		const transactions = []
		for (const method of ['get', 'put', 'update']) {
			const original = tab.whiteboards[method].bind(tab.whiteboards)
			tab.whiteboards[method] = (...args) => {
				transactions.push(WhiteboardDatabase.currentTransaction)
				return original(...args)
			}
		}

		await tab.markSaved(1, scene(2), {}, computeElementVersionHash(scene(2)), isScene(scene(2), {}))

		expect(transactions).toHaveLength(2)
		expect(transactions[0]).toBe(transactions[1])
		expect(transactions[0]?.mode).toBe('readwrite')
	})

	it('marks the stored draft clean when it is the uploaded scene, and keeps it', async () => {
		const tab = open()
		await tab.put(1, scene(1), {}, { viewBackgroundColor: '#000000' }, { hasPendingLocalChanges: true })

		await tab.markSaved(1, scene(1), {}, 7, isScene(scene(1), {}))

		expect(await tab.get(1)).toMatchObject({
			elements: scene(1),
			appState: { viewBackgroundColor: '#000000' },
			hasPendingLocalChanges: false,
			lastSyncedHash: 7,
		})
	})

	it('keeps a pending draft with other files', async () => {
		const tab = open()
		const files = { image: { id: 'image', dataURL: 'data:image/png;base64,' } }
		await tab.put(1, scene(1), files, undefined, { hasPendingLocalChanges: true })

		await tab.markSaved(1, scene(1), {}, 7, isScene(scene(1), {}))

		expect(await tab.get(1)).toMatchObject({ files, hasPendingLocalChanges: true })
	})

	it('stores the uploaded scene as saved when the board has no local copy', async () => {
		const tab = open()

		await tab.markSaved(1, scene(2), {}, 7, isScene(scene(2), {}))

		expect(await tab.get(1)).toMatchObject({ elements: scene(2), hasPendingLocalChanges: false, lastSyncedHash: 7 })
	})

	it('stores the uploaded scene over an older saved copy', async () => {
		const tab = open()
		await tab.put(1, scene(1), {}, undefined, { hasPendingLocalChanges: false })

		await tab.markSaved(1, scene(2), {}, 7, isScene(scene(2), {}))

		expect(await tab.get(1)).toMatchObject({ elements: scene(2), hasPendingLocalChanges: false })
	})
})
