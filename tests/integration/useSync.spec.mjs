/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSync } from '../../src/hooks/useSync.ts'
import { useCollaborationStore } from '../../src/stores/useCollaborationStore.ts'
import { useExcalidrawStore } from '../../src/stores/useExcalidrawStore.ts'
import { useJWTStore } from '../../src/stores/useJwtStore.ts'
import { useSyncStore } from '../../src/stores/useSyncStore.ts'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const scene = (version) => [{ id: 'A', version, versionNonce: version }]

describe('server saves of useSync', () => {
	let root
	let worker
	let editor
	let resolveJWT
	let onChange

	const serverSaves = () => worker.postMessage.mock.calls
		.map(([message]) => message)
		.filter((message) => message.type === 'SYNC_TO_SERVER')

	function Board() {
		onChange = useSync().onChange
		return null
	}

	beforeEach(async () => {
		worker = { postMessage: vi.fn() }
		editor = {
			elements: scene(1),
			getSceneElementsIncludingDeleted: () => editor.elements,
			getFiles: () => ({}),
			getAppState: () => ({}),
		}
		useWhiteboardConfigStore.setState({ fileId: 1, isReadOnly: false })
		useSyncStore.setState({ worker, isWorkerReady: true, initializeWorker: () => worker, savedSceneKey: null, pausedFileId: null })
		useCollaborationStore.setState({ status: 'online', isDedicatedSyncer: true, pendingServerMerge: false, socket: null, isInRoom: false })
		useJWTStore.setState({
			tokens: { 1: 'jwt' },
			getJWT: () => new Promise((resolve) => {
				resolveJWT = resolve
			}),
		})
		useExcalidrawStore.setState({ excalidrawAPI: editor })

		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))
		// A change starts a save, which waits for its token
		await act(async () => onChange())
	})

	afterEach(async () => {
		await act(async () => root.unmount())
	})

	it('sends the scene as it is once the token is ready', async () => {
		editor.elements = scene(2)
		await act(async () => resolveJWT('jwt'))

		expect(serverSaves().map(({ elements }) => elements)).toEqual([scene(2)])
	})

	it('sends nothing when the connection is lost during the wait', async () => {
		useCollaborationStore.setState({ pendingServerMerge: true })
		await act(async () => resolveJWT('jwt'))

		expect(serverSaves()).toEqual([])
	})

	it('keeps the final save when the board closes during the wait', async () => {
		await act(async () => root.unmount())
		// The editor clears its scene and reports that it is gone
		editor.elements = []
		useExcalidrawStore.getState().resetExcalidrawAPI()
		await act(async () => resolveJWT('jwt'))

		expect(serverSaves().map(({ elements }) => elements)).toEqual([scene(1)])
		root = createRoot(document.createElement('div'))
	})

	it('keeps the board only locally when it closes before the merge after a reconnect', async () => {
		useCollaborationStore.setState({ pendingServerMerge: true })
		await act(async () => root.unmount())
		await act(async () => resolveJWT('jwt'))

		expect(serverSaves()).toEqual([])
		expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'SYNC_TO_LOCAL', elements: scene(1), hasPendingLocalChanges: true }))
		root = createRoot(document.createElement('div'))
	})

	it('keeps a saved scene as a local change until the merge after a reconnect', async () => {
		await act(async () => resolveJWT('jwt'))
		// the scene was saved, but the server may have lost it while this tab was away
		useSyncStore.setState({ savedSceneKey: serverSaves()[0].sceneKey })
		useCollaborationStore.setState({ pendingServerMerge: true })
		await act(async () => root.unmount())

		expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'SYNC_TO_LOCAL', elements: scene(1), hasPendingLocalChanges: true }))
		root = createRoot(document.createElement('div'))
	})
})

describe('images in the websocket sync of useSync', () => {
	let root

	const image = (id, size) => ({ id, mimeType: 'image/png', dataURL: `data:image/png;base64,${'A'.repeat(size)}`, created: 1 })

	function Board() {
		useSync()
		return null
	}

	afterEach(async () => {
		await act(async () => root.unmount())
		useWhiteboardConfigStore.setState({ collabMaxMessageBytes: null })
	})

	let setToast

	async function sentImages(files, collabMaxMessageBytes) {
		const socket = { emit: vi.fn(), connected: true }
		setToast = vi.fn()
		useWhiteboardConfigStore.setState({ fileId: 1, isReadOnly: false, collabMaxMessageBytes })
		useSyncStore.setState({ worker: { postMessage: vi.fn() }, isWorkerReady: true, savedSceneKey: null, pausedFileId: null })
		useCollaborationStore.setState({ status: 'online', isDedicatedSyncer: false, pendingServerMerge: false, socket, isInRoom: true })
		useExcalidrawStore.setState({
			excalidrawAPI: {
				getSceneElementsIncludingDeleted: () => scene(1),
				getFiles: () => files,
				getAppState: () => ({}),
				setToast,
			},
		})

		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Board)))

		return socket.emit.mock.calls
			.map(([, , message]) => JSON.parse(new TextDecoder().decode(message)))
			.filter((message) => message.type === 'IMAGE_ADD')
			.map((message) => message.payload.file.id)
	}

	it('does not send an image the collaboration server would refuse, tells the user, and sends the others', async () => {
		expect(await sentImages({ small: image('small', 10), large: image('large', 2000) }, 1000)).toEqual(['small'])
		expect(setToast).toHaveBeenCalledOnce()
	})

	it('tells once about an image added later that the server refuses, and sends it when a connection allows it', async () => {
		const socket = { emit: vi.fn(), connected: true }
		const setToast = vi.fn()
		const files = {}
		let onChange
		function Editor() {
			onChange = useSync().onChange
			return null
		}
		useWhiteboardConfigStore.setState({ fileId: 1, isReadOnly: false, collabMaxMessageBytes: 1000 })
		useSyncStore.setState({ worker: { postMessage: vi.fn() }, isWorkerReady: true, savedSceneKey: null, pausedFileId: null })
		useCollaborationStore.setState({ status: 'online', isDedicatedSyncer: false, pendingServerMerge: false, socket, isInRoom: true })
		useExcalidrawStore.setState({
			excalidrawAPI: {
				getSceneElementsIncludingDeleted: () => scene(1),
				getFiles: () => files,
				getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
				setToast,
			},
		})
		root = createRoot(document.createElement('div'))
		await act(async () => root.render(createElement(Editor)))
		const sentImages = () => socket.emit.mock.calls
			.map(([, , message]) => JSON.parse(new TextDecoder().decode(message)))
			.filter((message) => message.type === 'IMAGE_ADD')
			.map((message) => message.payload.file.id)
		const change = async () => {
			await new Promise((resolve) => setTimeout(resolve, 600))
			await act(async () => onChange())
		}

		files.large = image('large', 2000)
		await change()
		await change()
		expect(sentImages()).toEqual([])
		expect(setToast).toHaveBeenCalledOnce()
		expect(setToast.mock.calls[0][0].message).toBe('This image is too large to share with others')

		useWhiteboardConfigStore.setState({ collabMaxMessageBytes: 10000 })
		await change()
		expect(sentImages()).toEqual(['large'])
		expect(setToast).toHaveBeenCalledOnce()
	})

	it('keeps to the limit of servers before this fix while the connection did not tell its own', async () => {
		expect(await sentImages({ small: image('small', 10), large: image('large', 3e6) }, null)).toEqual(['small'])
	})
})
