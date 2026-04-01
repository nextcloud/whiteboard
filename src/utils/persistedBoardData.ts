/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types'
import type { WhiteboardData } from '../database/db'
import { sanitizeAppStateForSync } from './sanitizeAppState'
import { computeElementVersionHash, mergeSceneElements } from './syncSceneData'

export interface PersistedBoardMeta {
	persistedRev: number
	updatedAt: number | null
	updatedBy: string | null
}

export interface PersistedBoardSnapshot {
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState: Partial<AppState>
	scrollToContent: boolean
}

export interface PersistedBoardDocument extends PersistedBoardSnapshot {
	meta: PersistedBoardMeta
}

type PersistedBoardInput = Partial<PersistedBoardDocument> & {
	data?: unknown
}

type BoardLoadResolution = {
	snapshot: PersistedBoardSnapshot
	meta: PersistedBoardMeta
	hasPendingLocalChanges: boolean
	lastSyncedHash: number
}

const DEFAULT_META: PersistedBoardMeta = {
	persistedRev: 0,
	updatedAt: null,
	updatedBy: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
	typeof value === 'object'
	&& value !== null
	&& !Array.isArray(value)
)

const coerceNonNegativeInteger = (value: unknown, fallback: number): number => (
	Number.isInteger(value) && Number(value) >= 0
		? Number(value)
		: fallback
)

const coerceNullableNumber = (value: unknown): number | null => (
	typeof value === 'number' && Number.isFinite(value)
		? value
		: null
)

const coerceNullableString = (value: unknown): string | null => (
	typeof value === 'string' && value.length > 0
		? value
		: null
)

const normalizeElements = (value: unknown): ExcalidrawElement[] => (
	Array.isArray(value)
		? value.filter(isRecord) as ExcalidrawElement[]
		: []
)

const normalizeFiles = (value: unknown): BinaryFiles => {
	if (!isRecord(value)) {
		return {}
	}

	const files: BinaryFiles = {}
	for (const [key, file] of Object.entries(value)) {
		if (file && isRecord(file)) {
			files[key] = file as BinaryFiles[string]
		}
	}

	return Object.fromEntries(
		Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
	) as BinaryFiles
}

const resolveOptionalScrollToContent = (value: unknown): boolean | undefined => {
	if (!isRecord(value)) {
		return undefined
	}

	if (typeof value.scrollToContent === 'boolean') {
		return value.scrollToContent
	}

	if (isRecord(value.appState) && typeof value.appState.scrollToContent === 'boolean') {
		return value.appState.scrollToContent
	}

	return undefined
}

const normalizeAppState = (value: unknown): Partial<AppState> => (
	isRecord(value)
		? sanitizeAppStateForSync(value as Partial<AppState>)
		: {}
)

const unwrapPersistedBoardValue = (value: unknown): unknown => {
	if (!isRecord(value) || !isRecord(value.data)) {
		return value
	}

	return value.data
}

const canonicalizeValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeValue(item))
	}

	if (!isRecord(value)) {
		return value
	}

	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nestedValue]) => [key, canonicalizeValue(nestedValue)]),
	)
}

export const normalizePersistedBoardMeta = (value: unknown): PersistedBoardMeta => {
	if (!isRecord(value)) {
		return { ...DEFAULT_META }
	}

	return {
		persistedRev: coerceNonNegativeInteger(value.persistedRev, DEFAULT_META.persistedRev),
		updatedAt: coerceNullableNumber(value.updatedAt),
		updatedBy: coerceNullableString(value.updatedBy),
	}
}

export const normalizePersistedBoardDocument = (value: unknown): PersistedBoardDocument => {
	const rawValue = unwrapPersistedBoardValue(value)
	const document = isRecord(rawValue) ? rawValue as PersistedBoardInput : {}
	const scrollToContent = resolveOptionalScrollToContent(document) ?? true

	return {
		meta: normalizePersistedBoardMeta(document.meta),
		elements: normalizeElements(document.elements),
		files: normalizeFiles(document.files),
		appState: normalizeAppState(document.appState),
		scrollToContent,
	}
}

export const extractSnapshotFromPersistedBoard = (value: unknown): PersistedBoardSnapshot => {
	const document = normalizePersistedBoardDocument(value)

	return {
		elements: document.elements,
		files: document.files,
		appState: document.appState,
		scrollToContent: document.scrollToContent,
	}
}

export const mergeLocalPendingWithServerSnapshot = (
	localValue: unknown,
	serverValue: unknown,
): PersistedBoardSnapshot => {
	const localSnapshot = extractSnapshotFromPersistedBoard(localValue)
	const serverSnapshot = extractSnapshotFromPersistedBoard(serverValue)
	const localScrollToContent = resolveOptionalScrollToContent(unwrapPersistedBoardValue(localValue))

	return {
		elements: mergeSceneElements(
			localSnapshot.elements,
			serverSnapshot.elements,
			localSnapshot.appState as AppState,
		),
		files: {
			...serverSnapshot.files,
			...localSnapshot.files,
		},
		appState: {
			...serverSnapshot.appState,
			...localSnapshot.appState,
		},
		scrollToContent: localScrollToContent ?? serverSnapshot.scrollToContent,
	}
}

export const areSnapshotsEquivalent = (leftValue: unknown, rightValue: unknown): boolean => {
	const leftSnapshot = extractSnapshotFromPersistedBoard(leftValue)
	const rightSnapshot = extractSnapshotFromPersistedBoard(rightValue)

	if (computeElementVersionHash(leftSnapshot.elements) !== computeElementVersionHash(rightSnapshot.elements)) {
		return false
	}

	return JSON.stringify(canonicalizeValue(leftSnapshot)) === JSON.stringify(canonicalizeValue(rightSnapshot))
}

export const resolveBoardLoadState = ({
	localBoard,
	serverBoard,
}: {
	localBoard?: WhiteboardData | null
	serverBoard?: unknown | null
}): BoardLoadResolution | null => {
	if (serverBoard) {
		const serverDocument = normalizePersistedBoardDocument(serverBoard)
		const hasPendingLocalChanges = Boolean(localBoard?.hasPendingLocalChanges)
		const hasLocalScene = Array.isArray(localBoard?.elements)

		if (hasPendingLocalChanges && hasLocalScene) {
			return {
				snapshot: mergeLocalPendingWithServerSnapshot(localBoard, serverDocument),
				meta: serverDocument.meta,
				hasPendingLocalChanges: true,
				lastSyncedHash: computeElementVersionHash(serverDocument.elements),
			}
		}

		return {
			snapshot: extractSnapshotFromPersistedBoard(serverDocument),
			meta: serverDocument.meta,
			hasPendingLocalChanges: false,
			lastSyncedHash: computeElementVersionHash(serverDocument.elements),
		}
	}

	if (!localBoard || !Array.isArray(localBoard.elements)) {
		return null
	}

	return {
		snapshot: extractSnapshotFromPersistedBoard(localBoard),
		meta: normalizePersistedBoardMeta({
			persistedRev: localBoard.persistedRev,
			updatedAt: localBoard.lastServerUpdatedAt,
			updatedBy: localBoard.lastServerUpdatedBy,
		}),
		hasPendingLocalChanges: localBoard.hasPendingLocalChanges ?? false,
		lastSyncedHash: localBoard.lastSyncedHash ?? computeElementVersionHash(localBoard.elements),
	}
}
