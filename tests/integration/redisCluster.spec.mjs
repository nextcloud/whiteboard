/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redis = vi.hoisted(() => ({
	createClient: vi.fn(() => ({ kind: 'single' })),
	createCluster: vi.fn(() => ({ kind: 'cluster' })),
}))
vi.mock('redis', () => redis)

const { default: RedisAdapter } = await import('../../websocket_server/Adapters/RedisAdapter.js')
const { default: Config } = await import('../../websocket_server/Utilities/ConfigUtility.js')
const { deleteKeys, isClusterClient, scanKeys } = await import('../../websocket_server/Utilities/RedisUtility.js')

const SECRET = 'p@ss:w0rd'

describe('choosing between a single node and a cluster', () => {
	const configuredUrl = Config.REDIS_URL

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	afterEach(() => {
		Config.REDIS_URL = configuredUrl
		redis.createClient.mockClear()
		redis.createCluster.mockClear()
		vi.restoreAllMocks()
	})

	it('builds a single client for one URL', () => {
		Config.REDIS_URL = 'redis://localhost:6379'

		RedisAdapter.createRedisClient()

		expect(redis.createCluster).not.toHaveBeenCalled()
		expect(redis.createClient).toHaveBeenCalledWith({ url: 'redis://localhost:6379' })
	})

	it('builds a single client for a unix socket', () => {
		Config.REDIS_URL = 'unix:///var/run/redis.sock?db=3'

		RedisAdapter.createRedisClient()

		expect(redis.createCluster).not.toHaveBeenCalled()
		expect(redis.createClient).toHaveBeenCalledWith({
			socket: { path: '/var/run/redis.sock' },
			database: 3,
		})
	})

	it('keeps a single client when the password holds a comma', () => {
		Config.REDIS_URL = 'redis://:one,two@localhost:6379'

		RedisAdapter.createRedisClient()

		expect(redis.createCluster).not.toHaveBeenCalled()
		expect(redis.createClient).toHaveBeenCalledWith({ url: 'redis://:one,two@localhost:6379' })
	})

	it('builds a cluster client from a list of seed nodes', () => {
		Config.REDIS_URL = 'redis://node1:6379,redis://node2:6379,redis://node3:6379'

		RedisAdapter.createRedisClient()

		expect(redis.createClient).not.toHaveBeenCalled()
		expect(redis.createCluster).toHaveBeenCalledWith({
			rootNodes: [
				{ url: 'redis://node1:6379' },
				{ url: 'redis://node2:6379' },
				{ url: 'redis://node3:6379' },
			],
		})
	})

	it('repeats the credentials of the first seed in the defaults', () => {
		Config.REDIS_URL = `redis://user:${encodeURIComponent(SECRET)}@node1:6379,redis://node2:6379`

		RedisAdapter.createRedisClient()

		const [options] = redis.createCluster.mock.calls[0]
		expect(options.defaults).toEqual({ username: 'user', password: SECRET })
	})

	it('repeats TLS in the defaults, which discovered nodes connect with', () => {
		Config.REDIS_URL = 'rediss://node1:6380,rediss://node2:6380'

		RedisAdapter.createRedisClient()

		const [options] = redis.createCluster.mock.calls[0]
		expect(options.defaults).toEqual({ socket: { tls: true } })
	})

	it('repeats both credentials and TLS when the first seed carries both', () => {
		Config.REDIS_URL = `rediss://user:${SECRET}@node1:6380,rediss://node2:6380`

		RedisAdapter.createRedisClient()

		const [options] = redis.createCluster.mock.calls[0]
		expect(options.defaults).toEqual({
			username: 'user',
			password: SECRET,
			socket: { tls: true },
		})
	})

	it('leaves the defaults out when the seeds need nothing', () => {
		Config.REDIS_URL = 'redis://node1:6379,redis://node2:6379'

		RedisAdapter.createRedisClient()

		const [options] = redis.createCluster.mock.calls[0]
		expect(options).not.toHaveProperty('defaults')
	})
})

/**
 * A stand-in for one node of a cluster.
 *
 * @param {string[]} keys the keys this node holds
 * @return {object} an object with the scanIterator() of a single client
 */
function fakeNode(keys) {
	return {
		async* scanIterator() {
			for (const key of keys) {
				yield key
			}
		},
	}
}

describe('scanning the keyspace', () => {
	it('recognises a cluster client by its nodeClient()', () => {
		expect(isClusterClient(fakeNode([]))).toBe(false)
		expect(isClusterClient({ nodeClient: () => {}, masters: [] })).toBe(true)
		expect(isClusterClient(null)).toBe(false)
	})

	it('scans a single client directly', async () => {
		const client = fakeNode(['a', 'b'])
		const seen = []
		for await (const key of scanKeys(client, { MATCH: 'x*' })) {
			seen.push(key)
		}
		expect(seen).toEqual(['a', 'b'])
	})

	it('scans every primary of a cluster through its own client', async () => {
		const nodes = [fakeNode(['a']), fakeNode(['b', 'c']), fakeNode([])]
		const masters = [{ id: 0 }, { id: 1 }, { id: 2 }]
		const cluster = {
			masters,
			nodeClient: vi.fn((master) => nodes[master.id]),
		}

		const seen = []
		for await (const key of scanKeys(cluster, { MATCH: 'x*' })) {
			seen.push(key)
		}

		expect(seen).toEqual(['a', 'b', 'c'])
		expect(cluster.nodeClient).toHaveBeenCalledTimes(3)
	})

	it('waits for a node client that is still connecting', async () => {
		const cluster = {
			masters: [{ id: 0 }],
			nodeClient: () => Promise.resolve(fakeNode(['a'])),
		}

		const seen = []
		for await (const key of scanKeys(cluster, {})) {
			seen.push(key)
		}

		expect(seen).toEqual(['a'])
	})
})

describe('deleting keys', () => {
	it('deletes a whole batch in one call on a single node', async () => {
		const client = { del: vi.fn(async () => 2) }

		await deleteKeys(client, ['a', 'b'])

		expect(client.del).toHaveBeenCalledTimes(1)
		expect(client.del).toHaveBeenCalledWith(['a', 'b'])
	})

	it('deletes one key at a time on a cluster, which refuses a batch across slots', async () => {
		const cluster = {
			masters: [],
			nodeClient: () => {},
			del: vi.fn(async () => 1),
		}

		await deleteKeys(cluster, ['a', 'b', 'c'])

		expect(cluster.del).toHaveBeenCalledTimes(3)
		expect(cluster.del.mock.calls.map(([key]) => key)).toEqual(['a', 'b', 'c'])
	})

	it('does nothing when there is nothing to delete', async () => {
		const client = { del: vi.fn() }

		await deleteKeys(client, [])

		expect(client.del).not.toHaveBeenCalled()
	})
})
