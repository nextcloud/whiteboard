import { describe, expect, it } from 'vitest'
import {
	buildBroadcastedElementVersions,
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
