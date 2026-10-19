import { describe, expect, it } from 'vitest'
import {
	buildBroadcastedElementVersions,
	computeSceneKey,
	getIncrementalSceneElements,
	updateBroadcastedElementVersions,
} from '../../src/utils/syncSceneData.ts'

describe('syncSceneData incremental bookkeeping', () => {
	it('treats same version with different nonce as a new element state', () => {
		const remoteElements = [
			{ id: 'E1', version: 2, versionNonce: 222, isDeleted: false },
		]
		const localElements = [
			{ id: 'E1', version: 2, versionNonce: 333, isDeleted: false },
		]

		const broadcastedElementVersions = buildBroadcastedElementVersions(remoteElements)
		const incrementalElements = getIncrementalSceneElements(localElements, broadcastedElementVersions)

		expect(incrementalElements).toHaveLength(1)
		expect(incrementalElements[0].versionNonce).toBe(333)
	})

	it('only advances markers for elements that were actually sent', () => {
		const allElements = [
			{ id: 'A', version: 1, versionNonce: 101, isDeleted: false },
			{ id: 'B', version: 4, versionNonce: 404, isDeleted: false },
		]
		const sentElements = [
			{ id: 'A', version: 2, versionNonce: 202, isDeleted: false },
		]

		const initialMarkers = buildBroadcastedElementVersions(allElements)
		const nextMarkers = updateBroadcastedElementVersions(initialMarkers, sentElements)

		expect(nextMarkers).toEqual({
			A: { version: 2, versionNonce: 202 },
			B: { version: 4, versionNonce: 404 },
		})
	})
})

describe('computeSceneKey', () => {
	const elements = [
		{ id: 'A', version: 1, versionNonce: 101, isDeleted: false },
		{ id: 'B', version: 4, versionNonce: 404, isDeleted: false },
	]

	it('ignores file order', () => {
		expect(computeSceneKey(elements, { f1: {}, f2: {} })).toBe(computeSceneKey(elements, { f2: {}, f1: {} }))
	})

	it('changes when an element or a file changes', () => {
		const key = computeSceneKey(elements, { f1: {} })

		expect(computeSceneKey([elements[0], { ...elements[1], version: 5, versionNonce: 505 }], { f1: {} })).not.toBe(key)
		expect(computeSceneKey([elements[0], { ...elements[1], isDeleted: true }], { f1: {} })).not.toBe(key)
		expect(computeSceneKey(elements, { f1: {}, f2: {} })).not.toBe(key)
	})
})
