/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'

// Keeps the element with the higher version, the remote one on a tie
vi.mock('@nextcloud/excalidraw', () => ({
	reconcileElements: (localElements, remoteElements) => {
		const localById = new Map(localElements.map((element) => [element.id, element]))
		const remoteIds = new Set(remoteElements.map((element) => element.id))
		return [
			...remoteElements.map((remote) => {
				const local = localById.get(remote.id)
				return local && (local.version ?? 0) > (remote.version ?? 0) ? local : remote
			}),
			...localElements.filter((element) => !remoteIds.has(element.id)),
		]
	},
}))

const { mergeElementsWithMetadata, prepareDuplicatedElements } = await import('../../src/utils/mergeElementsWithMetadata.ts')

describe('duplicated element metadata', () => {
	it('prepares only elements with newly generated IDs', () => {
		const existing = { id: 'existing', customData: { creatorProof: 'valid-proof' } }
		const duplicated = { id: 'duplicate', customData: { creatorProof: 'inherited-proof' } }
		const prepareElement = vi.fn((element) => ({
			...element,
			customData: { creator: { uid: 'alice' } },
		}))

		const result = prepareDuplicatedElements([existing, duplicated], [existing], prepareElement)

		expect(result[0]).toBe(existing)
		expect(result[1].customData.creator.uid).toBe('alice')
		expect(result[1].customData.creatorProof).toBeUndefined()
		expect(prepareElement).toHaveBeenCalledOnce()
		expect(prepareElement).toHaveBeenCalledWith(duplicated)
	})
})

describe('creator metadata reconciliation', () => {
	it('keeps the local creator for an existing element', () => {
		const local = [{
			id: 'element',
			customData: {
				creator: { uid: 'bob', displayName: 'Bob', createdAt: 1 },
				creatorProof: 'proof-bob',
			},
		}]
		const remote = [{
			id: 'element',
			customData: {
				creator: { uid: 'mallory', displayName: 'Mallory', createdAt: 2 },
				creatorProof: 'proof-mallory',
			},
		}]

		const [merged] = mergeElementsWithMetadata(local, remote, {})

		expect(merged.customData.creator.uid).toBe('bob')
		expect(merged.customData.creatorProof).toBe('proof-bob')
	})

	it('does not add a creator to an unattributed existing element', () => {
		const local = [{ id: 'element', customData: { aiGenerated: true } }]
		const remote = [{
			id: 'element',
			customData: {
				creator: { uid: 'mallory', displayName: 'Mallory', createdAt: 2 },
				creatorProof: 'proof-mallory',
			},
		}]

		const [merged] = mergeElementsWithMetadata(local, remote, {})

		expect(merged.customData.creator).toBeUndefined()
		expect(merged.customData.creatorProof).toBeUndefined()
	})

	it('accepts the collaboration-server creator for a new element', () => {
		const remote = [{
			id: 'new-element',
			customData: {
				creator: { uid: 'alice', displayName: 'Alice', createdAt: 2 },
				creatorProof: 'proof-alice',
				tableLock: { uid: 'alice', displayName: 'Alice', lockedAt: 2 },
			},
		}]

		const [merged] = mergeElementsWithMetadata([], remote, {})

		expect(merged.customData.creator.uid).toBe('alice')
		expect(merged.customData.creatorProof).toBe('proof-alice')
		expect(merged.customData.tableLock.uid).toBe('alice')
	})
})

describe('table metadata reconciliation', () => {
	const table = (version, tableHtml, tableLock) => ({
		id: 'table',
		version,
		customData: { isTable: true, tableHtml, ...(tableLock ? { tableLock } : {}) },
	})

	it('keeps the table content and lock state of the local element when it wins', () => {
		const [merged] = mergeElementsWithMetadata(
			[table(3, '<table>new</table>')],
			[table(2, '<table>old</table>', { uid: 'bob', displayName: 'Bob', lockedAt: 1 })],
			{},
		)

		expect(merged.customData.tableHtml).toBe('<table>new</table>')
		expect(merged.customData.tableLock).toBeUndefined()
	})

	it('takes the table content and lock of the remote element when it wins', () => {
		const lock = { uid: 'bob', displayName: 'Bob', lockedAt: 2 }
		const [merged] = mergeElementsWithMetadata(
			[table(2, '<table>old</table>')],
			[table(3, '<table>new</table>', lock)],
			{},
		)

		expect(merged.customData.tableHtml).toBe('<table>new</table>')
		expect(merged.customData.tableLock).toEqual(lock)
	})
})
