/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type BenchElement = Record<string, unknown> & {
	id: string
	type: string
	version: number
	versionNonce: number
	isDeleted: boolean
	updated: number
	x?: number
	y?: number
	width?: number
	height?: number
}

export type ElementSnapshot = {
	id: string
	type: string
	version: number
	isDeleted: boolean
	text?: string
	originalText?: string
	x?: number
	y?: number
}

export type SceneFixture = {
	elements: BenchElement[]
	textIds: string[]
	clusterIds: string[][]
	connectorIds: string[]
	frameIds: string[]
}

export type BenchmarkScenario = {
	key: string
	label: string
	build: (scale: number) => SceneFixture
}

export type MutationPlan = {
	label: string
	changedElements: number
	changedElementIds: string[]
	elements: BenchElement[]
	expectedElements: ElementSnapshot[]
}

export type BenchmarkMutation = {
	key: string
	label: string
	apply: (fixture: SceneFixture, scale: number) => MutationPlan
}

const BASE_TIMESTAMP = 1_710_000_000_000

function nextNonce(index: number) {
	return 10_000 + index * 31
}

function baseElement(
	id: string,
	type: string,
	index: number,
	x: number,
	y: number,
	width: number,
	height: number,
	extras: Record<string, unknown> = {},
): BenchElement {
	return {
		id,
		type,
		x,
		y,
		width,
		height,
		angle: 0,
		strokeColor: '#1f2937',
		backgroundColor: 'transparent',
		fillStyle: 'solid',
		strokeWidth: 1,
		strokeStyle: 'solid',
		roughness: 0,
		opacity: 100,
		groupIds: [],
		frameId: null,
		roundness: null,
		seed: index + 1,
		version: 1,
		versionNonce: nextNonce(index),
		isDeleted: false,
		boundElements: null,
		updated: BASE_TIMESTAMP + index,
		link: null,
		locked: false,
		...extras,
	}
}

function textElement(id: string, index: number, x: number, y: number, text: string, extras: Record<string, unknown> = {}): BenchElement {
	return baseElement(id, 'text', index, x, y, 220, 48, {
		text,
		originalText: text,
		fontSize: 20,
		fontFamily: 1,
		textAlign: 'left',
		verticalAlign: 'top',
		containerId: null,
		lineHeight: 1.25,
		baseline: 18,
		...extras,
	})
}

function rectangleElement(id: string, index: number, x: number, y: number, width: number, height: number, extras: Record<string, unknown> = {}): BenchElement {
	return baseElement(id, 'rectangle', index, x, y, width, height, {
		backgroundColor: '#fef3c7',
		strokeColor: '#92400e',
		roundness: { type: 3 },
		...extras,
	})
}

function frameElement(id: string, index: number, x: number, y: number, width: number, height: number, name: string): BenchElement {
	return baseElement(id, 'frame', index, x, y, width, height, {
		name,
		backgroundColor: '#fffaf0',
		strokeColor: '#c2410c',
	})
}

function lineElement(id: string, index: number, x: number, y: number, points: Array<[number, number]>, extras: Record<string, unknown> = {}): BenchElement {
	return baseElement(id, 'line', index, x, y, 0, 0, {
		points,
		lastCommittedPoint: points[points.length - 1] || null,
		startBinding: null,
		endBinding: null,
		...extras,
	})
}

function arrowElement(id: string, index: number, x: number, y: number, points: Array<[number, number]>, extras: Record<string, unknown> = {}): BenchElement {
	return baseElement(id, 'arrow', index, x, y, 0, 0, {
		points,
		lastCommittedPoint: points[points.length - 1] || null,
		startBinding: null,
		endBinding: null,
		startArrowhead: null,
		endArrowhead: 'triangle',
		...extras,
	})
}

function cloneElements(elements: readonly BenchElement[]) {
	return elements.map((element) => structuredClone(element))
}

function touchElements(elements: BenchElement[], ids: Iterable<string>, patch: (element: BenchElement, index: number) => BenchElement) {
	const idSet = new Set(ids)
	let touched = 0
	return elements.map((element) => {
		if (!idSet.has(element.id)) {
			return element
		}
		touched += 1
		return patch(element, touched)
	})
}

function moveElements(elements: BenchElement[], ids: Iterable<string>, dx: number, dy: number) {
	return touchElements(elements, ids, (element, order) => ({
		...element,
		x: typeof element.x === 'number' ? element.x + dx : element.x,
		y: typeof element.y === 'number' ? element.y + dy : element.y,
		version: element.version + 1,
		versionNonce: element.versionNonce + 1_000 + order,
		updated: element.updated + 30_000 + order,
	}))
}

function editTextElements(elements: BenchElement[], ids: Iterable<string>, suffix: string) {
	return touchElements(elements, ids, (element, order) => {
		if (element.type !== 'text') {
			return {
				...element,
				version: element.version + 1,
				versionNonce: element.versionNonce + 500 + order,
				updated: element.updated + 20_000 + order,
			}
		}

		const nextText = `${String(element.text || element.originalText || '')}${suffix}`
		return {
			...element,
			text: nextText,
			originalText: nextText,
			version: element.version + 1,
			versionNonce: element.versionNonce + 500 + order,
			updated: element.updated + 20_000 + order,
		}
	})
}

function rerouteConnectors(elements: BenchElement[], ids: Iterable<string>, offset: number) {
	return touchElements(elements, ids, (element, order) => {
		const points = Array.isArray(element.points)
			? (element.points as Array<[number, number]>).map(([x, y], pointIndex) => [
				x + offset + pointIndex,
				y + offset - pointIndex,
			])
			: element.points
		return {
			...element,
			points,
			lastCommittedPoint: Array.isArray(points) ? points[points.length - 1] : element.lastCommittedPoint,
			version: element.version + 1,
			versionNonce: element.versionNonce + 2_000 + order,
			updated: element.updated + 15_000 + order,
		}
	})
}

function markDeleted(elements: BenchElement[], ids: Iterable<string>) {
	return touchElements(elements, ids, (element, order) => ({
		...element,
		isDeleted: true,
		version: element.version + 1,
		versionNonce: element.versionNonce + 3_000 + order,
		updated: element.updated + 10_000 + order,
	}))
}

function toSnapshots(elements: readonly BenchElement[], ids: Iterable<string>) {
	const idSet = new Set(ids)
	return elements
		.filter((element) => idSet.has(element.id))
		.map((element) => ({
			id: element.id,
			type: element.type,
			version: element.version,
			isDeleted: element.isDeleted,
			text: typeof element.text === 'string' ? element.text : undefined,
			originalText: typeof element.originalText === 'string' ? element.originalText : undefined,
			x: typeof element.x === 'number' ? element.x : undefined,
			y: typeof element.y === 'number' ? element.y : undefined,
		}))
}

function buildRetroBoard(scale: number): SceneFixture {
	const columnCount = 4
	const notesPerColumn = 24 * scale
	const elements: BenchElement[] = []
	const textIds: string[] = []
	const clusterIds: string[][] = []
	const connectorIds: string[] = []
	const frameIds: string[] = []
	let index = 0

	for (let column = 0; column < columnCount; column += 1) {
		const frameId = `retro-frame-${column}`
		frameIds.push(frameId)
		elements.push(frameElement(frameId, index++, 80 + column * 360, 80, 320, 1_160, `Lane ${column + 1}`))

		for (let note = 0; note < notesPerColumn; note += 1) {
			const baseX = 110 + column * 360
			const baseY = 140 + note * 44
			const rectId = `retro-note-${column}-${note}`
			const textId = `retro-text-${column}-${note}`
			textIds.push(textId)
			elements.push(rectangleElement(rectId, index++, baseX, baseY, 260, 36, { frameId }))
			elements.push(textElement(textId, index++, baseX + 18, baseY + 10, `Retro note ${column + 1}.${note + 1}`, {
				containerId: rectId,
				frameId,
			}))

			if (note % 6 === 0) {
				const ids: string[] = []
				for (let offset = 0; offset < 6 && note + offset < notesPerColumn; offset += 1) {
					ids.push(`retro-note-${column}-${note + offset}`, `retro-text-${column}-${note + offset}`)
				}
				clusterIds.push(ids)
			}
		}
	}

	for (let column = 0; column < columnCount - 1; column += 1) {
		for (let row = 0; row < Math.max(6, 6 * scale); row += 1) {
			const connectorId = `retro-link-${column}-${row}`
			connectorIds.push(connectorId)
			elements.push(arrowElement(
				connectorId,
				index++,
				330 + column * 360,
				190 + row * 170,
				[[0, 0], [160, 10]],
				{ frameId: null, strokeColor: '#ea580c' },
			))
		}
	}

	return {
		elements,
		textIds,
		clusterIds,
		connectorIds,
		frameIds,
	}
}

function buildPlanningFlow(scale: number): SceneFixture {
	const stageCount = 6
	const nodesPerStage = 18 * scale
	const elements: BenchElement[] = []
	const textIds: string[] = []
	const clusterIds: string[][] = []
	const connectorIds: string[] = []
	const frameIds: string[] = []
	let index = 0

	for (let stage = 0; stage < stageCount; stage += 1) {
		const frameId = `flow-frame-${stage}`
		frameIds.push(frameId)
		elements.push(frameElement(frameId, index++, 70 + stage * 280, 70, 240, 1_260, `Stage ${stage + 1}`))

		for (let node = 0; node < nodesPerStage; node += 1) {
			const x = 100 + stage * 280
			const y = 130 + node * 62
			const shapeId = `flow-shape-${stage}-${node}`
			const textId = `flow-text-${stage}-${node}`
			const isDecision = node % 5 === 0
			textIds.push(textId)
			elements.push(baseElement(shapeId, isDecision ? 'diamond' : 'rectangle', index++, x, y, 180, 44, {
				frameId,
				backgroundColor: isDecision ? '#dbeafe' : '#dcfce7',
				strokeColor: isDecision ? '#2563eb' : '#15803d',
				roundness: isDecision ? null : { type: 3 },
			}))
			elements.push(textElement(textId, index++, x + 16, y + 12, `Step ${stage + 1}.${node + 1}`, {
				containerId: shapeId,
				frameId,
			}))

			if (node < nodesPerStage - 1) {
				const connectorId = `flow-link-${stage}-${node}`
				connectorIds.push(connectorId)
				elements.push(arrowElement(connectorId, index++, x + 90, y + 44, [[0, 0], [0, 18]], {
					frameId,
					strokeColor: '#64748b',
				}))
			}
		}

		for (let block = 0; block < nodesPerStage; block += 6) {
			const ids: string[] = []
			for (let offset = 0; offset < 6 && block + offset < nodesPerStage; offset += 1) {
				ids.push(`flow-shape-${stage}-${block + offset}`, `flow-text-${stage}-${block + offset}`)
				if (block + offset < nodesPerStage - 1) {
					ids.push(`flow-link-${stage}-${block + offset}`)
				}
			}
			clusterIds.push(ids)
		}
	}

	for (let stage = 0; stage < stageCount - 1; stage += 1) {
		for (let row = 0; row < Math.max(8, 8 * scale); row += 1) {
			const connectorId = `flow-cross-link-${stage}-${row}`
			connectorIds.push(connectorId)
			elements.push(arrowElement(
				connectorId,
				index++,
				250 + stage * 280,
				180 + row * 120,
				[[0, 0], [140, 0]],
				{ strokeColor: '#0f766e' },
			))
		}
	}

	return {
		elements,
		textIds,
		clusterIds,
		connectorIds,
		frameIds,
	}
}

function buildMediaReview(scale: number): SceneFixture {
	const laneCount = 3
	const itemsPerLane = 14 * scale
	const elements: BenchElement[] = []
	const textIds: string[] = []
	const clusterIds: string[][] = []
	const connectorIds: string[] = []
	const frameIds: string[] = []
	let index = 0

	for (let lane = 0; lane < laneCount; lane += 1) {
		const frameId = `media-frame-${lane}`
		frameIds.push(frameId)
		elements.push(frameElement(frameId, index++, 80 + lane * 470, 70, 410, 1_240, `Review lane ${lane + 1}`))

		for (let item = 0; item < itemsPerLane; item += 1) {
			const baseX = 110 + lane * 470
			const baseY = 130 + item * 78
			const cardId = `media-card-${lane}-${item}`
			const captionId = `media-caption-${lane}-${item}`
			const commentId = `media-comment-${lane}-${item}`
			textIds.push(captionId, commentId)
			elements.push(rectangleElement(cardId, index++, baseX, baseY, 220, 64, {
				frameId,
				backgroundColor: '#dbeafe',
				strokeColor: '#1d4ed8',
			}))
			elements.push(textElement(captionId, index++, baseX + 242, baseY + 8, `Asset ${lane + 1}.${item + 1} caption`, {
				frameId,
			}))
			elements.push(textElement(commentId, index++, baseX + 242, baseY + 40, `Reviewer note ${lane + 1}.${item + 1}`, {
				frameId,
				fontSize: 16,
				height: 32,
			}))

			const connectorId = `media-link-${lane}-${item}`
			connectorIds.push(connectorId)
			elements.push(lineElement(connectorId, index++, baseX + 220, baseY + 30, [[0, 0], [20, 0], [20, 18]], {
				frameId,
				strokeColor: '#7c3aed',
			}))

			if (item % 4 === 0) {
				const ids: string[] = []
				for (let offset = 0; offset < 4 && item + offset < itemsPerLane; offset += 1) {
					ids.push(
						`media-card-${lane}-${item + offset}`,
						`media-caption-${lane}-${item + offset}`,
						`media-comment-${lane}-${item + offset}`,
						`media-link-${lane}-${item + offset}`,
					)
				}
				clusterIds.push(ids)
			}
		}
	}

	return {
		elements,
		textIds,
		clusterIds,
		connectorIds,
		frameIds,
	}
}

export const benchmarkScenarios: BenchmarkScenario[] = [
	{ key: 'retro-board', label: 'retro board', build: buildRetroBoard },
	{ key: 'planning-flow', label: 'planning flow', build: buildPlanningFlow },
	{ key: 'media-review', label: 'media review', build: buildMediaReview },
]

export const benchmarkMutations: BenchmarkMutation[] = [
	{
		key: 'single-text-edit',
		label: 'single text edit',
		apply: (fixture) => {
			const changedElementIds = [fixture.textIds[0]]
			const elements = editTextElements(cloneElements(fixture.elements), changedElementIds, ' updated')
			return {
				label: 'single text edit',
				changedElements: 1,
				changedElementIds,
				expectedElements: toSnapshots(elements, changedElementIds),
				elements,
			}
		},
	},
	{
		key: 'selection-drag',
		label: 'selection drag',
		apply: (fixture, scale) => {
			const changedElementIds = fixture.clusterIds[0] || fixture.textIds.slice(0, 8 * scale)
			const elements = moveElements(cloneElements(fixture.elements), changedElementIds, 96, 48)
			return {
				label: 'selection drag',
				changedElements: changedElementIds.length,
				changedElementIds,
				expectedElements: toSnapshots(elements, changedElementIds),
				elements,
			}
		},
	},
	{
		key: 'mixed-session-burst',
		label: 'mixed session burst',
		apply: (fixture, scale) => {
			let elements = cloneElements(fixture.elements)
			const editedTextIds = fixture.textIds.slice(0, Math.max(6, 6 * scale))
			const movedClusterIds = fixture.clusterIds.flat().slice(0, Math.max(18, 18 * scale))
			const reroutedConnectorIds = fixture.connectorIds.slice(0, Math.max(8, 8 * scale))
			const deletedIds = fixture.textIds.slice(-Math.max(2, 2 * scale))
			elements = editTextElements(elements, editedTextIds, ' revised')
			elements = moveElements(elements, movedClusterIds, 72, 36)
			elements = rerouteConnectors(elements, reroutedConnectorIds, 12)
			elements = markDeleted(elements, deletedIds)

			const nextIndex = elements.length + 1
			const addedElements: BenchElement[] = [
				arrowElement(`added-arrow-${scale}-1`, nextIndex, 180, 180, [[0, 0], [120, 30]], { strokeColor: '#dc2626' }),
				arrowElement(`added-arrow-${scale}-2`, nextIndex + 1, 360, 320, [[0, 0], [90, -24]], { strokeColor: '#dc2626' }),
				textElement(`added-text-${scale}-1`, nextIndex + 2, 240, 140, 'New follow-up action'),
			]
			elements.push(...addedElements)

			const changedElementIds = Array.from(new Set([
				...editedTextIds,
				...movedClusterIds,
				...reroutedConnectorIds,
				...deletedIds,
				...addedElements.map((element) => element.id),
			]))

			return {
				label: 'mixed session burst',
				changedElements: changedElementIds.length,
				changedElementIds,
				expectedElements: toSnapshots(elements, changedElementIds),
				elements,
			}
		},
	},
]

export function selectScenarios(keys: string[]) {
	const selected = benchmarkScenarios.filter((scenario) => keys.includes(scenario.key))
	if (selected.length === 0) {
		throw new Error(`Unknown scenario selection: ${keys.join(', ')}`)
	}
	return selected
}

export function selectMutations(keys: string[]) {
	const selected = benchmarkMutations.filter((mutation) => keys.includes(mutation.key))
	if (selected.length === 0) {
		throw new Error(`Unknown mutation selection: ${keys.join(', ')}`)
	}
	return selected
}

export function formatBytes(bytes: number) {
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(2)} MB`
	}
	if (bytes >= 1_000) {
		return `${(bytes / 1_000).toFixed(1)} KB`
	}
	return `${bytes} B`
}
