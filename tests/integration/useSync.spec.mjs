/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSync } from '../../src/hooks/useSync.ts'
import { useCollaborationStore } from '../../src/stores/useCollaborationStore.ts'
import { useExcalidrawStore } from '../../src/stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore.ts'
import { setBoardSync } from '../../src/sync/boardSync.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const scene = (version) => [{ id: 'A', version, versionNonce: version }]

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
		setBoardSync(null)
	})

	let setToast

	// Images this tab has that Nextcloud lacks go to the room when the tab joins it
	async function sentImages(files, collabMaxMessageBytes) {
		const socket = { emit: vi.fn(), connected: true }
		setToast = vi.fn()
		setBoardSync({ epoch: 'e1', unsavedChanges: () => ({ elements: [], files }), close: () => {} })
		useWhiteboardConfigStore.setState({ fileId: 1, isReadOnly: false, collabMaxMessageBytes })
		useCollaborationStore.setState({ status: 'online', isDedicatedSyncer: false, socket, isInRoom: true })
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
		useCollaborationStore.setState({ status: 'online', isDedicatedSyncer: false, socket, isInRoom: true })
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
