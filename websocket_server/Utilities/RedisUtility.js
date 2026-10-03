/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Whether the given client talks to a Redis Cluster rather than a single node.
 *
 * @param {object} client a redis client
 * @return {boolean} true for a cluster client
 */
export function isClusterClient(client) {
	return typeof client?.nodeClient === 'function'
}

/**
 * Iterate the keys matching a pattern.
 *
 * A scan only ever covers the keyspace of the node it runs on, which is why the
 * cluster client has no scanIterator() of its own. Scan every primary through
 * its own client instead, so the caller sees the whole keyspace either way.
 *
 * @param {object} client a redis client, one node or a cluster
 * @param {object} options the options to hand to scanIterator()
 * @yields {string} each matching key
 */
export async function* scanKeys(client, options) {
	if (!isClusterClient(client)) {
		yield* client.scanIterator(options)
		return
	}

	for (const master of client.masters) {
		const nodeClient = await client.nodeClient(master)
		yield* nodeClient.scanIterator(options)
	}
}

/**
 * Delete the given keys.
 *
 * Redis refuses a DEL whose keys do not all live in the same hash slot, and the
 * keys returned by a scan across a cluster generally do not, so delete them one
 * by one there. A single node still takes the whole batch in one call.
 *
 * @param {object} client a redis client, one node or a cluster
 * @param {string[]} keys the keys to delete
 * @return {Promise<void>}
 */
export async function deleteKeys(client, keys) {
	if (keys.length === 0) {
		return
	}

	if (!isClusterClient(client)) {
		await client.del(keys)
		return
	}

	await Promise.all(keys.map((key) => client.del(key)))
}
