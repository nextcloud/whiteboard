/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { isOutdatedSceneBroadcast, SCENE_SCHEMA_VERSION, sceneNotice } from '../../src/utils/sceneSchema.ts'
import CreatorMetadataUtility from '../../websocket_server/Utilities/CreatorMetadataUtility.js'

describe('scene broadcasts from older clients', () => {
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

	it('sends a restore note in the form the collaboration server passes on', () => {
		expect(CreatorMetadataUtility.isSceneRestoreReloadPayload(sceneNotice('restored', { epoch: 'e2', rev: 7 }))).toBe(true)
		expect(isOutdatedSceneBroadcast(sceneNotice('saved', { epoch: 'e2', rev: 7 }))).toBe(false)
	})

	it('leaves other broadcasts alone', () => {
		expect(isOutdatedSceneBroadcast({ type: 'MOUSE_LOCATION', payload: {} })).toBe(false)
		expect(isOutdatedSceneBroadcast({ type: 'IMAGE_ADD', payload: {} })).toBe(false)
	})
})
