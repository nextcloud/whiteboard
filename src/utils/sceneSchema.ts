/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Sent with scene writes and scene broadcasts. Clients older than 3.0 do not
 * send it; they drop element types they do not know, so their scenes are refused.
 * A SCENE_RESTORE only asks peers to reload the board from the server, so it is
 * followed from any client.
 */
export const SCENE_SCHEMA_VERSION = 2

const SCENE_BROADCAST_TYPES = new Set(['SCENE_INIT', 'SCENE_UPDATE'])

/**
 * Whether a broadcast carries a scene from a client older than 3.0
 * @param message decoded broadcast
 */
export function isOutdatedSceneBroadcast(message: { type?: unknown, schemaVersion?: unknown }): boolean {
	return SCENE_BROADCAST_TYPES.has(message.type as string) && message.schemaVersion !== SCENE_SCHEMA_VERSION
}
