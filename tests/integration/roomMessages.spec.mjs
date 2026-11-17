/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { encodeRoomMessage, isOutdatedSceneBroadcast, noticeSync, SCENE_SCHEMA_VERSION, sceneMessage, sceneNotice } from '../../src/sync/roomMessages.ts'
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

	it('keeps the epoch and schema of a scene change through the collaboration server', () => {
		const relayed = CreatorMetadataUtility.canonicalizeBroadcastPayload(sceneMessage('e2', { elements: [{ id: 'a', type: 'rectangle' }] }), '1', CreatorMetadataUtility.getActor({ id: 'alice', name: 'Alice' }), 'secret')

		expect({ epoch: relayed.epoch, schemaVersion: relayed.schemaVersion, ids: relayed.payload.elements.map((element) => element.id) }).toEqual({ epoch: 'e2', schemaVersion: SCENE_SCHEMA_VERSION, ids: ['a'] })
	})

	it('tells the room the epoch and revision of a save and of a restore', () => {
		const heard = (message) => noticeSync(JSON.parse(new TextDecoder().decode(encodeRoomMessage(message))))

		expect(heard(sceneNotice('saved', { epoch: 'e2', rev: 7, restored: true }))).toEqual({ epoch: 'e2', rev: 7 })
		expect(heard(sceneNotice('restored', { epoch: 'e3', rev: 9 }))).toEqual({ epoch: 'e3', rev: 9 })
		// A restore in Files closes the board first, and older clients send the restore note alone
		expect(heard(sceneNotice('restored'))).toBeUndefined()
		expect(heard({ type: 'SCENE_RESTORE', payload: { reloadFromServer: true } })).toBeUndefined()
	})

	it('leaves other broadcasts alone', () => {
		expect(isOutdatedSceneBroadcast({ type: 'MOUSE_LOCATION', payload: {} })).toBe(false)
		expect(isOutdatedSceneBroadcast({ type: 'IMAGE_ADD', payload: {} })).toBe(false)
	})
})
