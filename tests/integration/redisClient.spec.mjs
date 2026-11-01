/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RedisMemoryServer } from 'redis-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import RedisAdapter from '../../websocket_server/Adapters/RedisAdapter.js'
import RoomStateStore from '../../websocket_server/Stores/RoomStateStore.js'
import Config from '../../websocket_server/Utilities/ConfigUtility.js'

// enough keys that SCAN has to return them over several replies
const KEY_COUNT = 250

describe('the Redis client on a real server', () => {
	const configuredUrl = Config.REDIS_URL
	let redisServer
	let client

	beforeAll(async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		redisServer = new RedisMemoryServer()
		const host = await redisServer.getHost()
		const port = await redisServer.getPort()
		Config.REDIS_URL = `redis://${host}:${port}`
		client = RedisAdapter.createRedisClient()
		await client.connect()
	})

	afterAll(async () => {
		await client?.close()
		await redisServer?.stop()
		Config.REDIS_URL = configuredUrl
		vi.restoreAllMocks()
	})

	beforeEach(async () => {
		await client.flushAll()
	})

	it('speaks RESP2, which needs no HELLO from the server', async () => {
		expect(await client.sendCommand(['CLIENT', 'INFO'])).toMatch(/\bresp=2\b/)
	})

	it('leaves commands without a timeout, as redis 4 did', () => {
		expect(client.options.commandOptions).toHaveProperty('timeout', undefined)
	})

	it('clears every key under the adapter prefix and nothing else', async () => {
		const keys = Array.from({ length: KEY_COUNT }, (_, i) => `general_key${i}`)
		await Promise.all(keys.map((key) => client.set(key, '1')))
		await client.set('socket_kept', '1')

		await new RedisAdapter(client, { prefix: 'general_' }).clear()

		expect(await client.keys('general_*')).toEqual([])
		expect(await client.keys('*')).toEqual(['socket_kept'])
	})

	it('lists every room state key, not just the first reply', async () => {
		const store = new RoomStateStore({ redisClient: client })
		const names = Array.from({ length: KEY_COUNT }, (_, i) => `presentation_${i}`)
		await Promise.all(names.map((name) => store.setValue(name, { name })))
		await store.setHashEntry('recording_1', 'user', { id: 'alice' })

		expect((await store.listValueKeys('presentation_*')).sort()).toEqual([...names].sort())
		expect(await store.listHashKeys('recording_*')).toEqual(['recording_1'])
	})
})
