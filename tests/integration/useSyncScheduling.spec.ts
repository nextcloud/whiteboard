import { describe, expect, it, vi } from 'vitest'
import {
	runServerApiSyncIfAllowed,
	runWebSocketSyncIfAllowed,
} from '../../src/utils/syncExecution'

const createExcalidrawAPI = () => ({
	getSceneElementsIncludingDeleted: () => ([
		{ id: 'element-1', type: 'rectangle' },
	] as never),
	getFiles: () => ({
		'file-1': {
			id: 'file-1',
			dataURL: 'data:image/png;base64,aaaa',
		},
	} as never),
	getAppState: () => ({
		selectedElementIds: {},
		scrollX: 0,
		scrollY: 0,
		zoom: { value: 1 },
	}),
})

describe('useSync scheduling guards', () => {
	it('follower tabs do not emit SYNC_TO_SERVER work', async () => {
		const worker = { postMessage: vi.fn() }
		const getJWT = vi.fn(async () => 'jwt-token')

		const didSend = await runServerApiSyncIfAllowed({
			authority: {
				isDedicatedSyncer: true,
				isLocalLeader: false,
				isReadOnly: false,
			},
			collabStatus: 'online',
			fileId: 42,
			excalidrawAPI: createExcalidrawAPI(),
			getJWT,
			worker,
			isWorkerReady: true,
		})

		expect(didSend).toBe(false)
		expect(getJWT).not.toHaveBeenCalled()
		expect(worker.postMessage).not.toHaveBeenCalled()
	})

	it('follower tabs do not emit websocket scene or image sync', () => {
		const socket = { emit: vi.fn() }

		const result = runWebSocketSyncIfAllowed({
			authority: {
				isDedicatedSyncer: true,
				isLocalLeader: false,
				isReadOnly: false,
			},
			collabStatus: 'online',
			fileId: 42,
			excalidrawAPI: createExcalidrawAPI(),
			socket,
			prevSyncedFiles: {},
		})

		expect(result.sent).toBe(false)
		expect(socket.emit).not.toHaveBeenCalled()
	})
})
