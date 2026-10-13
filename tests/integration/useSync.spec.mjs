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
