/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment jsdom

import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSync } from '../../src/hooks/useSync'
import { useCollaborationStore } from '../../src/stores/useCollaborationStore'
import { useExcalidrawStore } from '../../src/stores/useExcalidrawStore'
import { useSyncStore } from '../../src/stores/useSyncStore'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore'

vi.mock('@nextcloud/router', () => ({
	generateUrl: (path: string) => `/index.php/${path}`,
}))

vi.mock('@nextcloud/excalidraw', () => ({
	hashString: () => 1,
}))

vi.mock('../../src/utils/logger', () => ({
	default: {
		debug: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock('../../src/utils/sanitizeAppState', () => ({
	sanitizeAppStateForSync: (appState: unknown) => appState ?? {},
}))

vi.mock('../../src/utils/syncSceneData', () => ({
	buildBroadcastedElementVersions: (elements: Array<{ id: string, version: number }>) => (
		elements.reduce<Record<string, number>>((versions, element) => {
			versions[element.id] = element.version
			return versions
		}, {})
	),
	planIncrementalSceneSync: ({ elements }: { elements: Array<{ id: string, version: number }> }) => {
		if (elements.length === 0) {
			return { type: 'noop' }
		}

		return {
			type: 'broadcast',
			sceneHash: 1,
			sceneElements: elements,
			broadcastedElementVersions: elements.reduce<Record<string, number>>((versions, element) => {
				versions[element.id] = element.version
				return versions
			}, {}),
		}
	},
}))

vi.mock('../../src/stores/useWhiteboardConfigStore', async () => {
	const { create } = await import('zustand')
	return {
		useWhiteboardConfigStore: create(() => ({
			fileId: 42,
			isReadOnly: false,
		})),
	}
})

vi.mock('../../src/stores/useExcalidrawStore', async () => {
	const { create } = await import('zustand')
	return {
		useExcalidrawStore: create(() => ({
			excalidrawAPI: null,
			setExcalidrawAPI: () => {},
			resetExcalidrawAPI: () => {},
		})),
	}
})

vi.mock('../../src/stores/useSyncStore', async () => {
	const { create } = await import('zustand')
	return {
		useSyncStore: create(() => ({
			worker: null,
			isWorkerReady: false,
			initializeWorker: () => null,
			terminateWorker: () => {},
			setWorker: () => {},
			setIsWorkerReady: () => {},
		})),
		logSyncResult: () => {},
	}
})

vi.mock('../../src/stores/useJwtStore', async () => {
	const { create } = await import('zustand')
	return {
		useJWTStore: create(() => ({
			tokens: { 42: 'jwt-token' },
			getJWT: async () => 'jwt-token',
			parseJwt: () => ({ userid: 'test-user' }),
		})),
	}
})

vi.mock('../../src/stores/useCollaborationStore', async () => {
	const { create } = await import('zustand')
	const useCollaborationStore = create((set) => ({
		status: 'online',
		socket: null,
		isDedicatedSyncer: true,
		lastSceneHash: null,
		broadcastedElementVersions: {},
		setStatus: (status: string) => set({ status }),
		setSocket: (socket: unknown) => set({ socket }),
		setDedicatedSyncer: (isDedicatedSyncer: boolean) => set({ isDedicatedSyncer }),
		setIsInRoom: () => {},
		setLastSceneHash: (lastSceneHash: number | null) => set({ lastSceneHash }),
		replaceBroadcastedElementVersions: (broadcastedElementVersions: Record<string, number>) => set({ broadcastedElementVersions }),
		mergeBroadcastedElementVersions: () => {},
		resetSceneSyncState: () => set({ lastSceneHash: null, broadcastedElementVersions: {} }),
		authError: {},
		incrementAuthFailure: () => {},
		clearAuthError: () => {},
		resetStore: () => {},
		presenterId: null,
		isPresentationMode: false,
		isPresenting: false,
		presentationStartTime: null,
		autoFollowPresenter: false,
		setPresentationState: () => {},
		setAutoFollowPresenter: () => {},
		followedUserId: null,
		votings: [],
		addVoting: () => {},
		updateVoting: () => {},
		setVotings: () => {},
	}))

	return { useCollaborationStore }
})

type HookHandlers = ReturnType<typeof useSync>

type MockElement = {
	id: string
	type: string
	version: number
	text?: string
	isDeleted?: boolean
}

type MockWorkerMessage = {
	type: string
	elements?: MockElement[]
}

function HookHarness({ onReady }: { onReady: (handlers: HookHandlers) => void }) {
	const handlers = useSync()

	useEffect(() => {
		onReady(handlers)
	}, [handlers, onReady])

	return null
}

const appState = {
	scrollX: 0,
	scrollY: 0,
	zoom: { value: 1 },
	selectedElementIds: {},
}

const decodeScenePayload = (payload: Uint8Array<ArrayBuffer>) => {
	return JSON.parse(new TextDecoder().decode(payload))
}

describe('useSync scheduling', () => {
	let container: HTMLDivElement
	let root: Root
	let handlers: HookHandlers
	let sceneElements: MockElement[]
	let files: Record<string, never>
	let worker: { postMessage: ReturnType<typeof vi.fn> }
	let socket: { emit: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.useFakeTimers()
		sceneElements = []
		files = {}
		worker = { postMessage: vi.fn() }
		socket = { emit: vi.fn() }

		useWhiteboardConfigStore.setState({
			fileId: 42,
			isReadOnly: false,
		})

		useExcalidrawStore.setState({
			excalidrawAPI: {
				getSceneElementsIncludingDeleted: () => sceneElements,
				getAppState: () => appState,
				getFiles: () => files,
			},
		})

		useSyncStore.setState({
			worker,
			isWorkerReady: true,
			initializeWorker: () => null,
			terminateWorker: () => {},
		})

		useCollaborationStore.setState({
			status: 'online',
			socket,
			isDedicatedSyncer: true,
			lastSceneHash: null,
			broadcastedElementVersions: {},
		})

		container = document.createElement('div')
		document.body.appendChild(container)
		root = createRoot(container)

		act(() => {
			root.render(createElement(HookHarness, {
				onReady: (nextHandlers: HookHandlers) => {
					handlers = nextHandlers
				},
			}))
		})
	})

	afterEach(() => {
		useCollaborationStore.setState({
			isDedicatedSyncer: false,
		})

		act(() => {
			root.unmount()
		})
		container.remove()
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it('sends the first server and websocket sync on the trailing edge with the settled scene', async () => {
		act(() => {
			handlers.onChange([], appState as never, files as never)
		})

		const syncToServerMessages = worker.postMessage.mock.calls.filter(([message]: [MockWorkerMessage]) => message.type === 'SYNC_TO_SERVER')
		expect(syncToServerMessages).toHaveLength(0)
		expect(socket.emit).toHaveBeenCalledTimes(0)

		sceneElements = [{
			id: 'text-1',
			type: 'text',
			version: 1,
			text: 'Live text',
		}]

		await vi.advanceTimersByTimeAsync(499)
		expect(socket.emit).toHaveBeenCalledTimes(0)

		await vi.advanceTimersByTimeAsync(1)
		expect(socket.emit).toHaveBeenCalledTimes(1)
		expect(socket.emit.mock.calls[0][0]).toBe('server-broadcast')
		expect(decodeScenePayload(socket.emit.mock.calls[0][2] as Uint8Array<ArrayBuffer>)).toMatchObject({
			type: 'SCENE_UPDATE',
			payload: {
				elements: [{
					id: 'text-1',
					text: 'Live text',
				}],
			},
		})

		await vi.advanceTimersByTimeAsync(9499)
		expect(worker.postMessage.mock.calls.filter(([message]: [MockWorkerMessage]) => message.type === 'SYNC_TO_SERVER')).toHaveLength(0)

		await vi.advanceTimersByTimeAsync(1)
		const serverMessages = worker.postMessage.mock.calls
			.map(([message]: [MockWorkerMessage]) => message)
			.filter((message) => message.type === 'SYNC_TO_SERVER')

		expect(serverMessages).toHaveLength(1)
		expect(serverMessages[0].elements).toEqual([{
			id: 'text-1',
			type: 'text',
			version: 1,
			text: 'Live text',
		}])
	})

	it('reschedules pending server and websocket syncs after readiness transitions instead of flushing immediately', async () => {
		useSyncStore.setState({
			worker,
			isWorkerReady: false,
		})
		useCollaborationStore.setState({
			status: 'connecting',
			socket,
			isDedicatedSyncer: false,
			lastSceneHash: null,
			broadcastedElementVersions: {},
		})

		act(() => {
			handlers.onChange([], appState as never, files as never)
		})

		sceneElements = [{
			id: 'text-2',
			type: 'text',
			version: 2,
			text: 'Ready later',
		}]

		act(() => {
			useSyncStore.setState({
				worker,
				isWorkerReady: true,
			})
			useCollaborationStore.setState({
				status: 'online',
				socket,
				isDedicatedSyncer: true,
				lastSceneHash: null,
				broadcastedElementVersions: {},
			})
		})

		expect(socket.emit).toHaveBeenCalledTimes(0)
		expect(worker.postMessage.mock.calls.filter(([message]: [MockWorkerMessage]) => message.type === 'SYNC_TO_SERVER')).toHaveLength(0)

		await vi.advanceTimersByTimeAsync(500)
		expect(socket.emit).toHaveBeenCalledTimes(1)
		expect(decodeScenePayload(socket.emit.mock.calls[0][2] as Uint8Array<ArrayBuffer>)).toMatchObject({
			type: 'SCENE_UPDATE',
			payload: {
				elements: [{
					id: 'text-2',
					text: 'Ready later',
				}],
			},
		})

		await vi.advanceTimersByTimeAsync(9500)
		const serverMessages = worker.postMessage.mock.calls
			.map(([message]: [MockWorkerMessage]) => message)
			.filter((message) => message.type === 'SYNC_TO_SERVER')

		expect(serverMessages).toHaveLength(1)
		expect(serverMessages[0].elements).toEqual([{
			id: 'text-2',
			type: 'text',
			version: 2,
			text: 'Ready later',
		}])
	})
})
