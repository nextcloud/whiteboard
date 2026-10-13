/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from 'vitest'
import { selectSavesToServer, useCollaborationStore } from '../../src/stores/useCollaborationStore.ts'
import { isOutdatedSceneBroadcast, SCENE_SCHEMA_VERSION } from '../../src/utils/sceneSchema.ts'

describe('scene broadcasts from clients older than 3.0', () => {
	it.each(['SCENE_INIT', 'SCENE_UPDATE'])('drops %s without the schema marker', (type) => {
		expect(isOutdatedSceneBroadcast({ type, payload: { elements: [] } })).toBe(true)
		expect(isOutdatedSceneBroadcast({ type, schemaVersion: 1, payload: { elements: [] } })).toBe(true)
	})

	it.each(['SCENE_INIT', 'SCENE_UPDATE'])('applies %s with the schema marker', (type) => {
		expect(isOutdatedSceneBroadcast({ type, schemaVersion: SCENE_SCHEMA_VERSION, payload: {} })).toBe(false)
	})

	it('follows a reload-only restore from any client', () => {
		expect(isOutdatedSceneBroadcast({ type: 'SCENE_RESTORE', payload: { reloadFromServer: true } })).toBe(false)
	})

	it('leaves other broadcasts alone', () => {
		expect(isOutdatedSceneBroadcast({ type: 'MOUSE_LOCATION', payload: {} })).toBe(false)
		expect(isOutdatedSceneBroadcast({ type: 'IMAGE_ADD', payload: {} })).toBe(false)
	})
})

describe('saving while a client older than 3.0 is in the room', () => {
	afterEach(() => {
		useCollaborationStore.getState().resetStore()
	})

	it('saves only as the elected saver by default', () => {
		expect(selectSavesToServer(useCollaborationStore.getState())).toBe(false)

		useCollaborationStore.getState().setDedicatedSyncer(true)
		expect(selectSavesToServer(useCollaborationStore.getState())).toBe(true)
	})

	it('saves once an outdated client sent a scene, until the store is reset', () => {
		useCollaborationStore.getState().setHasOutdatedPeer()
		expect(selectSavesToServer(useCollaborationStore.getState())).toBe(true)

		useCollaborationStore.getState().resetStore()
		expect(selectSavesToServer(useCollaborationStore.getState())).toBe(false)
	})
})
