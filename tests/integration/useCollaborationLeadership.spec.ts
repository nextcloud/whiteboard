import { describe, expect, it, vi } from 'vitest'
import {
	sendRequestedImageIfAllowed,
	sendSceneBootstrapIfAllowed,
} from '../../src/utils/collaborationBootstrap'

const createBootstrapAPI = () => ({
	getSceneElementsIncludingDeleted: () => ([
		{ id: 'element-1', type: 'rectangle' },
	] as never),
	getFiles: () => ({
		'file-1': {
			id: 'file-1',
			dataURL: 'data:image/png;base64,aaaa',
		},
	} as never),
})

describe('collaboration bootstrap leadership', () => {
	it('follower tabs do not answer scene bootstrap requests', () => {
		const socket = { connected: true, emit: vi.fn() }

		const didSend = sendSceneBootstrapIfAllowed({
			isDedicatedSyncer: true,
			isLocalLeader: false,
			fileId: 42,
			excalidrawAPI: createBootstrapAPI(),
			socket,
		})

		expect(didSend).toBe(false)
		expect(socket.emit).not.toHaveBeenCalled()
	})

	it('follower tabs do not answer image requests', () => {
		const socket = { connected: true, emit: vi.fn() }

		const didSend = sendRequestedImageIfAllowed({
			isDedicatedSyncer: true,
			isLocalLeader: false,
			fileId: 42,
			excalidrawAPI: createBootstrapAPI(),
			socket,
			requestedFileId: 'file-1',
		})

		expect(didSend).toBe(false)
		expect(socket.emit).not.toHaveBeenCalled()
	})
})
