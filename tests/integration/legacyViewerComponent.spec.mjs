/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, reactive } from 'vue'

const opened = vi.hoisted(() => [])
const lifecycle = vi.hoisted(() => [])
vi.mock('../../src/utils/renderWhiteboardView.tsx', () => ({
	matchesComparisonRequest: () => false,
	renderWhiteboardView: (element, { fileId }) => {
		opened.push(fileId)
		lifecycle.push(`mount ${fileId}`)
		return {
			unmount: () => {
				opened.splice(opened.indexOf(fileId), 1)
				lifecycle.push(`unmount ${fileId}`)
			},
		}
	},
}))

const { createWhiteboardComponent } = await import('../../src/viewer/legacyViewerComponent.ts')

describe('a board in the legacy viewer', () => {
	let app

	afterEach(() => {
		app?.unmount()
		opened.length = 0
		lifecycle.length = 0
	})

	it('opens only the file the viewer shows, not the hidden neighbours it renders', async () => {
		const Whiteboard = createWhiteboardComponent({ collabBackendUrl: '', resolveSharingToken: () => null })
		// As the viewer renders them: the shown file with `active`, the previous one hidden without it
		const state = reactive({ shown: 1, hidden: 2 })
		app = createApp({
			render: () => h('div', [
				h('div', { key: state.hidden, class: 'viewer__file-wrapper viewer__file-wrapper--hidden' }, [h(Whiteboard, { fileid: state.hidden })]),
				h('div', { key: state.shown, class: 'viewer__file-wrapper' }, [h(Whiteboard, { fileid: state.shown, active: true })]),
			]),
		})
		app.mount(document.body.appendChild(document.createElement('div')))
		await vi.waitFor(() => expect(opened).toEqual([1]))

		// The user steps back: the hidden neighbour is shown, the shown file is hidden
		Object.assign(state, { shown: 2, hidden: 1 })
		await vi.waitFor(() => expect(opened).toEqual([2]))
		// Boards share the page's stores, so the one shown before closes before the next opens
		expect(lifecycle).toEqual(['mount 1', 'unmount 1', 'mount 2'])
	})
})
