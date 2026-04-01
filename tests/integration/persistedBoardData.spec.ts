import { describe, expect, it } from 'vitest'
import {
	extractSnapshotFromPersistedBoard,
	resolveBoardLoadState,
} from '../../src/utils/persistedBoardData'

describe('persistedBoardData helpers', () => {
	it('keeps local pending data while rebasing onto server durable revision', () => {
		const result = resolveBoardLoadState({
			localBoard: {
				id: 42,
				elements: [
					{ id: 'local-1', version: 2, versionNonce: 20, isDeleted: false, type: 'rectangle' },
				] as never,
				files: {
					localFile: { id: 'localFile', dataURL: 'local' },
				} as never,
				appState: {
					viewBackgroundColor: '#fff',
					name: 'local',
				},
				scrollToContent: false,
				hasPendingLocalChanges: true,
				persistedRev: 2,
			},
			serverBoard: {
				meta: {
					persistedRev: 7,
					updatedAt: 1743494412345,
					updatedBy: 'bob',
				},
				elements: [
					{ id: 'server-1', version: 1, versionNonce: 10, isDeleted: false, type: 'ellipse' },
				],
				files: {
					serverFile: { id: 'serverFile', dataURL: 'server' },
				},
				appState: {
					viewBackgroundColor: '#000',
					gridSize: 10,
				},
				scrollToContent: true,
			},
		})

		expect(result).not.toBeNull()
		expect(result?.hasPendingLocalChanges).toBe(true)
		expect(result?.meta.persistedRev).toBe(7)
		expect(result?.meta.updatedBy).toBe('bob')
		expect(result?.snapshot.scrollToContent).toBe(false)
		expect(result?.snapshot.files).toMatchObject({
			serverFile: { id: 'serverFile', dataURL: 'server' },
			localFile: { id: 'localFile', dataURL: 'local' },
		})
		expect(result?.snapshot.appState).toMatchObject({
			viewBackgroundColor: '#fff',
			gridSize: 10,
			name: 'local',
		})
	})

	it('accepts raw revisioned board JSON with top-level meta for read-only consumers', () => {
		const snapshot = extractSnapshotFromPersistedBoard({
			meta: {
				persistedRev: 9,
				updatedAt: 1743494412345,
				updatedBy: 'alice',
			},
			elements: [
				{ id: 'shape-1', version: 1, versionNonce: 10, isDeleted: false, type: 'diamond' },
			],
			files: {
				fileA: { id: 'fileA', dataURL: 'data:image/png;base64,aaaa' },
			},
			appState: {
				viewBackgroundColor: '#fafafa',
			},
			scrollToContent: false,
		})

		expect(snapshot.elements).toHaveLength(1)
		expect(snapshot.files).toMatchObject({
			fileA: { id: 'fileA', dataURL: 'data:image/png;base64,aaaa' },
		})
		expect(snapshot.appState).toMatchObject({
			viewBackgroundColor: '#fafafa',
		})
		expect(snapshot.scrollToContent).toBe(false)
	})
})
