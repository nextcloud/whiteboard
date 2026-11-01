/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redis = vi.hoisted(() => ({
	createClient: vi.fn(),
	createCluster: vi.fn(),
}))
vi.mock('redis', () => redis)

const { default: RedisAdapter } = await import('../../websocket_server/Adapters/RedisAdapter.js')
const { default: Config } = await import('../../websocket_server/Utilities/ConfigUtility.js')

describe('errors emitted by the Redis client', () => {
	const configuredUrl = Config.REDIS_URL
	let errorLog

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
		redis.createClient.mockImplementation(() => new EventEmitter())
		redis.createCluster.mockImplementation(() => new EventEmitter())
	})

	afterEach(() => {
		Config.REDIS_URL = configuredUrl
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it.each([
		['a single node', 'redis://localhost:6379'],
		['a unix socket', 'unix:///var/run/redis.sock'],
		['a cluster', 'redis://node1:6379,redis://node2:6379'],
	])('does not end the process when %s loses its connection', (_, url) => {
		Config.REDIS_URL = url

		const client = RedisAdapter.createRedisClient()

		expect(client.listenerCount('error')).toBe(1)
		expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow()
		expect(errorLog).toHaveBeenCalledWith('Redis client error:', 'read ECONNRESET')
	})

	it('logs a repeated message once a minute rather than on every reconnect attempt', () => {
		vi.useFakeTimers()
		Config.REDIS_URL = 'redis://node1:6379,redis://node2:6379'
		const client = RedisAdapter.createRedisClient()
		const refused = new Error('connect ECONNREFUSED 127.0.0.1:7105')

		for (let i = 0; i < 10; i++) {
			client.emit('error', refused)
			vi.advanceTimersByTime(500)
		}
		expect(errorLog).toHaveBeenCalledTimes(1)

		client.emit('error', new Error('read ECONNRESET'))
		expect(errorLog).toHaveBeenCalledTimes(2)

		vi.advanceTimersByTime(60 * 1000)
		client.emit('error', refused)
		expect(errorLog).toHaveBeenCalledTimes(3)
	})
})
