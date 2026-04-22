import { describe, expect, it, vi } from 'vitest'

vi.mock('@nextcloud/excalidraw', () => ({
	hashElementsVersion: vi.fn((elements = []) => elements.reduce(
		(hash, element, index) => hash + ((element.versionNonce ?? element.version ?? 0) * (index + 1)),
		0,
	)),
}))

const {
	buildBroadcastedElementVersions,
	computeElementVersionHash,
	getIncrementalSceneElements,
	mergeBroadcastedElementVersions,
	planIncrementalSceneSync,
} = await import('../../src/utils/syncSceneData.ts')

function makeElement(id, version = 1, versionNonce = version * 100) {
	return {
		id,
		version,
		versionNonce,
	}
}

describe('syncSceneData incremental selection', () => {
	it('selects only the changed element from a large scene', () => {
		const originalElements = Array.from({ length: 45 }, (_value, index) =>
			makeElement(`element-${index + 1}`),
		)
		const broadcastedVersions = buildBroadcastedElementVersions(originalElements)
		const updatedElements = originalElements.map((element, index) =>
			index === 17
				? makeElement(element.id, element.version + 1)
				: element,
		)

		const incrementalElements = getIncrementalSceneElements(
			updatedElements,
			broadcastedVersions,
		)

		expect(incrementalElements).toHaveLength(1)
		expect(incrementalElements[0]).toMatchObject({
			id: 'element-18',
			version: 2,
		})
	})

	it('selects newly added elements without resending the full scene', () => {
		const originalElements = Array.from({ length: 45 }, (_value, index) =>
			makeElement(`element-${index + 1}`),
		)
		const broadcastedVersions = buildBroadcastedElementVersions(originalElements)
		const updatedElements = [
			...originalElements,
			makeElement('element-46'),
		]

		const incrementalElements = getIncrementalSceneElements(
			updatedElements,
			broadcastedVersions,
		)

		expect(incrementalElements).toHaveLength(1)
		expect(incrementalElements[0]).toMatchObject({
			id: 'element-46',
			version: 1,
		})
	})

	it('merges remote versions without downgrading already synced elements', () => {
		const syncedVersions = {
			E1: 5,
			E2: 3,
		}

		const mergedVersions = mergeBroadcastedElementVersions(
			syncedVersions,
			[
				makeElement('E1', 4),
				makeElement('E2', 6),
			],
		)

		expect(mergedVersions).toEqual({
			E1: 5,
			E2: 6,
		})
	})

	it('skips scene broadcast and advances sync markers after remote-only changes', () => {
		const elements = [
			makeElement('E1', 4, 444),
			makeElement('E2', 5, 555),
		]
		const plan = planIncrementalSceneSync({
			elements,
			broadcastedElementVersions: {
				E1: 4,
				E2: 5,
			},
			lastSceneHash: 123,
		})

		expect(plan).toEqual({
			type: 'advance',
			sceneHash: computeElementVersionHash(elements),
			broadcastedElementVersions: {
				E1: 4,
				E2: 5,
			},
		})
	})

	it('broadcasts only unsent local edits after remote versions are merged', () => {
		const lastSentElements = [
			makeElement('E1', 3, 101),
			makeElement('E2', 5, 202),
		]
		const reconciledElements = [
			makeElement('E1', 4, 303),
			makeElement('E2', 6, 404),
		]
		const syncedVersions = mergeBroadcastedElementVersions(
			buildBroadcastedElementVersions(lastSentElements),
			[makeElement('E1', 4, 303)],
		)

		const plan = planIncrementalSceneSync({
			elements: reconciledElements,
			broadcastedElementVersions: syncedVersions,
			lastSceneHash: 505,
		})

		expect(plan).toEqual({
			type: 'broadcast',
			sceneHash: computeElementVersionHash(reconciledElements),
			sceneElements: [makeElement('E2', 6, 404)],
			broadcastedElementVersions: {
				E2: 6,
			},
		})
	})
})
