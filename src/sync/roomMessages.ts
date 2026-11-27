/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BoardRevision } from './answer.ts'

/**
 * Sent with scene writes and scene broadcasts. Older clients send whole scenes
 * that would replace newer boards (2), or no version at all and drop element
 * types they do not know, so their scenes are refused. A SCENE_RESTORE only
 * asks peers to reload the board from the server, so it is followed from any
 * client.
 */
export const SCENE_SCHEMA_VERSION = 3

const SCENE_BROADCAST_TYPES = new Set(['SCENE_INIT', 'SCENE_UPDATE'])

/**
 * The note that tells the room the board changed, so tabs fetch it. Its
 * epoch and revision go next to the payload: the collaboration server
 * passes a restore note only with the payload `{ reloadFromServer: true }`.
 *
 * @param type saved or restored
 * @param sync the board's epoch and revision after the change, when known
 */
export function sceneNotice(type: 'saved' | 'restored', sync?: BoardRevision) {
	const mark = sync ? { epoch: sync.epoch, rev: sync.rev } : undefined
	return type === 'saved'
		? { type: 'SCENE_SAVED', schemaVersion: SCENE_SCHEMA_VERSION, ...mark }
		: { type: 'SCENE_RESTORE', schemaVersion: SCENE_SCHEMA_VERSION, ...mark, payload: { reloadFromServer: true } }
}

/**
 * The epoch and revision a note of `sceneNotice` tells; none from an older
 * client's restore note
 *
 * @param message decoded broadcast
 */
export function noticeSync(message: { epoch?: unknown, rev?: unknown }): BoardRevision | undefined {
	return typeof message.epoch === 'string' && typeof message.rev === 'number' ? { epoch: message.epoch, rev: message.rev } : undefined
}

/**
 * A scene change for the room, with the epoch it belongs to
 *
 * @param epoch
 * @param payload
 */
export function sceneMessage(epoch: string | null | undefined, payload: object) {
	return { type: 'SCENE_UPDATE', schemaVersion: SCENE_SCHEMA_VERSION, epoch, payload }
}

/**
 * The bytes a message for the room is sent as
 *
 * @param message
 */
export function encodeRoomMessage(message: object): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(message))
}

/**
 * Whether a broadcast carries a scene from an older client
 * @param message decoded broadcast
 */
export function isOutdatedSceneBroadcast(message: { type?: unknown, schemaVersion?: unknown }): boolean {
	return SCENE_BROADCAST_TYPES.has(message.type as string) && message.schemaVersion !== SCENE_SCHEMA_VERSION
}
