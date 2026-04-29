import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhiteboardData } from '../../src/database/db'
import { createSyncWorkerHandlers } from '../../src/workers/syncWorkerCore'

const createElement = (id: string, version = 1, versionNonce = 10) => ({
	id,
	type: 'rectangle',
	version,
	versionNonce,
	isDeleted: false,
})

const createDatabase = (initial?: Partial<WhiteboardData>) => {
	let stored: WhiteboardData | undefined = initial
		? {
			id: 42,
			elements: [],
			files: {},
			appState: {},
			scrollToContent: true,
			hasPendingLocalChanges: false,
			persistedRev: 0,
			lastServerUpdatedAt: null,
			lastServerUpdatedBy: null,
			...initial,
		}
		: undefined

	const put = vi.fn(async (
		fileId: number,
		elements: WhiteboardData['elements'],
		files: WhiteboardData['files'],
		appState?: WhiteboardData['appState'],
		options: {
			scrollToContent?: boolean
			hasPendingLocalChanges?: boolean
			lastSyncedHash?: number
			persistedRev?: number
			lastServerUpdatedAt?: number | null
			lastServerUpdatedBy?: string | null
		} = {},
	) => {
		stored = {
			id: fileId,
			elements: [...elements],
			files,
			appState,
			scrollToContent: options.scrollToContent ?? stored?.scrollToContent ?? true,
			hasPendingLocalChanges: options.hasPendingLocalChanges ?? stored?.hasPendingLocalChanges ?? false,
			lastSyncedHash: options.lastSyncedHash ?? stored?.lastSyncedHash,
			persistedRev: options.persistedRev ?? stored?.persistedRev ?? 0,
			lastServerUpdatedAt: options.lastServerUpdatedAt ?? stored?.lastServerUpdatedAt ?? null,
			lastServerUpdatedBy: options.lastServerUpdatedBy ?? stored?.lastServerUpdatedBy ?? null,
			savedAt: Date.now(),
		}
		return fileId
	})

	return {
		get: vi.fn(async () => stored),
		put,
		getStored: () => stored,
	}
}

describe('syncWorker durable revision handling', () => {
	beforeEach(() => {
		vi.useRealTimers()
	})

	it('sends baseRev from IndexedDB metadata and clears pending on success', async () => {
		const database = createDatabase({
			persistedRev: 7,
			appState: { viewBackgroundColor: '#fff' },
		})
		const postMessage = vi.fn()
		const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body))
			expect(payload.data.baseRev).toBe(7)
			expect(payload.data.appState).toMatchObject({ viewBackgroundColor: '#fafafa' })
			expect(payload.data.scrollToContent).toBe(false)

			return new Response(JSON.stringify({
				status: 'success',
				meta: {
					persistedRev: 8,
					updatedAt: 1743494412345,
					updatedBy: 'alice',
				},
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const handlers = createSyncWorkerHandlers({
			database: database as never,
			fetchFn: fetchFn as never,
			postMessage,
		})

		await handlers.handleSyncToServer({
			type: 'SYNC_TO_SERVER',
			fileId: 42,
			url: 'https://example.invalid/whiteboard',
			jwt: 'jwt-token',
			elements: [createElement('shape-1')] as never,
			files: {} as never,
			appState: { viewBackgroundColor: '#fafafa' },
			scrollToContent: false,
		})

		expect(database.put).toHaveBeenCalled()
		expect(database.getStored()).toMatchObject({
			hasPendingLocalChanges: false,
			persistedRev: 8,
			lastServerUpdatedAt: 1743494412345,
			lastServerUpdatedBy: 'alice',
			scrollToContent: false,
		})
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'SERVER_SYNC_COMPLETE',
			fileId: 42,
			persistedRev: 8,
		}))
	})

	it('treats identical 409 payloads as idempotent success and updates durable revision', async () => {
		const database = createDatabase({
			persistedRev: 3,
		})
		const postMessage = vi.fn()
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({
			status: 'conflict',
			data: {
				meta: {
					persistedRev: 4,
					updatedAt: 1743494412345,
					updatedBy: 'bob',
				},
				elements: [createElement('shape-1')],
				files: {},
				appState: {
					viewBackgroundColor: '#fff',
				},
				scrollToContent: true,
			},
		}), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		}))

		const handlers = createSyncWorkerHandlers({
			database: database as never,
			fetchFn: fetchFn as never,
			postMessage,
		})

		await handlers.handleSyncToServer({
			type: 'SYNC_TO_SERVER',
			fileId: 42,
			url: 'https://example.invalid/whiteboard',
			jwt: 'jwt-token',
			elements: [createElement('shape-1')] as never,
			files: {} as never,
			appState: { viewBackgroundColor: '#fff' },
			scrollToContent: true,
		})

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'SERVER_SYNC_COMPLETE',
			conflict: true,
			persistedRev: 4,
		}))
		expect(database.getStored()).toMatchObject({
			hasPendingLocalChanges: false,
			persistedRev: 4,
			lastServerUpdatedBy: 'bob',
		})
	})

	it('merges divergent 409 payloads, keeps pending state, and retries with the new server revision', async () => {
		const database = createDatabase({
			persistedRev: 1,
		})
		const postMessage = vi.fn()
		const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body))
			if (fetchFn.mock.calls.length === 1) {
				expect(payload.data.baseRev).toBe(1)
				return new Response(JSON.stringify({
					status: 'conflict',
					data: {
						meta: {
							persistedRev: 2,
							updatedAt: 1743494412345,
							updatedBy: 'bob',
						},
						elements: [createElement('server-shape', 4, 40)],
						files: {
							serverFile: { id: 'serverFile', dataURL: 'server' },
						},
						appState: {
							viewBackgroundColor: '#000',
						},
						scrollToContent: true,
					},
				}), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				})
			}

			expect(payload.data.baseRev).toBe(2)
			expect(payload.data.files).toMatchObject({
				serverFile: { id: 'serverFile', dataURL: 'server' },
				localFile: { id: 'localFile', dataURL: 'local' },
			})
			expect(payload.data.appState).toMatchObject({
				viewBackgroundColor: '#fff',
				gridSize: 10,
			})

			return new Response(JSON.stringify({
				status: 'success',
				meta: {
					persistedRev: 3,
					updatedAt: 1743494412999,
					updatedBy: 'alice',
				},
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const handlers = createSyncWorkerHandlers({
			database: database as never,
			fetchFn: fetchFn as never,
			postMessage,
		})

		await handlers.handleSyncToServer({
			type: 'SYNC_TO_SERVER',
			fileId: 42,
			url: 'https://example.invalid/whiteboard',
			jwt: 'jwt-token',
			elements: [createElement('local-shape', 5, 50)] as never,
			files: {
				localFile: { id: 'localFile', dataURL: 'local' },
			} as never,
			appState: {
				viewBackgroundColor: '#fff',
				gridSize: 10,
			},
			scrollToContent: false,
		})

		expect(fetchFn).toHaveBeenCalledTimes(2)
		expect(database.put).toHaveBeenCalledWith(
			42,
			expect.any(Array),
			expect.objectContaining({
				serverFile: { id: 'serverFile', dataURL: 'server' },
				localFile: { id: 'localFile', dataURL: 'local' },
			}),
			expect.objectContaining({
				viewBackgroundColor: '#fff',
				gridSize: 10,
			}),
			expect.objectContaining({
				hasPendingLocalChanges: true,
				persistedRev: 2,
			}),
		)
		expect(database.getStored()).toMatchObject({
			hasPendingLocalChanges: false,
			persistedRev: 3,
			lastServerUpdatedBy: 'alice',
		})
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'SERVER_SYNC_COMPLETE',
			conflict: true,
			persistedRev: 3,
		}))
	})

	it('does not report conflict responses as success-by-skip after retry exhaustion', async () => {
		const database = createDatabase({
			persistedRev: 1,
		})
		const postMessage = vi.fn()
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({
			status: 'conflict',
			data: {
				meta: {
					persistedRev: 2,
					updatedAt: 1743494412345,
					updatedBy: 'bob',
				},
				elements: [createElement('server-shape', 4, 40)],
				files: {},
				appState: {},
				scrollToContent: true,
			},
		}), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		}))

		const handlers = createSyncWorkerHandlers({
			database: database as never,
			fetchFn: fetchFn as never,
			postMessage,
		})

		await handlers.handleSyncToServer({
			type: 'SYNC_TO_SERVER',
			fileId: 42,
			url: 'https://example.invalid/whiteboard',
			jwt: 'jwt-token',
			elements: [createElement('local-shape', 5, 50)] as never,
			files: {} as never,
			appState: {},
			scrollToContent: true,
		})

		expect(fetchFn).toHaveBeenCalledTimes(3)
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'SERVER_SYNC_CONFLICT',
			fileId: 42,
		}))
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'SERVER_SYNC_COMPLETE',
			skipped: true,
		}))
		expect(database.getStored()).toMatchObject({
			hasPendingLocalChanges: true,
			persistedRev: 2,
		})
	})
})
