/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
 * The note that tells the room the board changed, so tabs fetch it. The
 * collaboration server passes a restore note only as `{ reloadFromServer: true }`.
 *
 * @param type saved or restored
 * @param sync the board's epoch and revision after the change
 * @param sync.epoch
 * @param sync.rev
 */
export function sceneNotice(type: 'saved' | 'restored', sync: { epoch: string, rev: number }) {
	return type === 'saved'
		? { type: 'SCENE_SAVED', schemaVersion: SCENE_SCHEMA_VERSION, payload: sync }
		: { type: 'SCENE_RESTORE', schemaVersion: SCENE_SCHEMA_VERSION, payload: { reloadFromServer: true } }
}

/**
 * Whether a broadcast carries a scene from an older client
 * @param message decoded broadcast
 */
export function isOutdatedSceneBroadcast(message: { type?: unknown, schemaVersion?: unknown }): boolean {
	return SCENE_BROADCAST_TYPES.has(message.type as string) && message.schemaVersion !== SCENE_SCHEMA_VERSION
}
