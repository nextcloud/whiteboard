/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RedisAdapter from '../../websocket_server/Adapters/RedisAdapter.js'
import Config from '../../websocket_server/Utilities/ConfigUtility.js'

const SECRET = 'sup3r-s3cr3t'

describe('splitting a configured Redis URL', () => {
	it.each([
		['a single node', 'redis://localhost:6379', ['redis://localhost:6379']],
		['a unix socket', 'unix:///var/run/redis.sock', ['unix:///var/run/redis.sock']],
		[
			'a list of seed nodes',
			'redis://node1:6379,redis://node2:6379,redis://node3:6379',
			['redis://node1:6379', 'redis://node2:6379', 'redis://node3:6379'],
		],
		[
			'a list with spaces around the commas',
			'redis://node1:6379 , redis://node2:6379',
			['redis://node1:6379', 'redis://node2:6379'],
		],
		[
			'a list with a trailing comma',
			'redis://node1:6379,redis://node2:6379,',
			['redis://node1:6379', 'redis://node2:6379'],
		],
		[
			'a comma inside the password',
			`redis://:${SECRET},${SECRET}@localhost:6379`,
			[`redis://:${SECRET},${SECRET}@localhost:6379`],
		],
		[
			'a comma inside the username',
			`redis://user,name:${SECRET}@localhost:6379`,
			[`redis://user,name:${SECRET}@localhost:6379`],
		],
		[
			'a list whose parts are not all URLs',
			'redis://node1:6379,node2:6379',
			['redis://node1:6379,node2:6379'],
		],
	])('keeps %s together as expected', (_case, configured, expected) => {
		expect(RedisAdapter.splitRedisUrls(configured)).toEqual(expected)
	})
})

describe('redacting a configured Redis URL', () => {
	it.each([
		// the two examples written down in .env.example and the README
		['redis://localhost:6379', 'redis://localhost:6379'],
		[
			'redis://user:password@redis.example.com:6379/0',
			'redis://***:***@redis.example.com:6379/0',
		],
		// the seed node list documented for Redis Cluster
		[
			'redis://node1:6379,redis://node2:6379,redis://node3:6379',
			'redis://node1:6379,redis://node2:6379,redis://node3:6379',
		],
		[
			`redis://user:${SECRET}@node1:6379,redis://node2:6379`,
			'redis://***:***@node1:6379,redis://node2:6379',
		],
		// one credential rather than both
		[`redis://:${SECRET}@localhost:6379`, 'redis://:***@localhost:6379'],
		['redis://onlyuser@localhost:6379', 'redis://***@localhost:6379'],
		// percent encoded credentials
		['redis://us%40er:p%40ss%3Aword@localhost:6379/2', 'redis://***:***@localhost:6379/2'],
		// TLS, and a unix socket, which carries no credentials at all
		[`rediss://user:${SECRET}@redis.example.com:6380`, 'rediss://***:***@redis.example.com:6380'],
		['unix:///var/run/redis.sock?db=3', 'unix:///var/run/redis.sock?db=3'],
		// a comma in the password must not be read as a list of nodes
		[`redis://:${SECRET},${SECRET}@localhost:6379`, 'redis://:***@localhost:6379'],
		// nothing parsable to redact, so nothing is printed
		[`redis://:${SECRET}@`, '<unparsable REDIS_URL>'],
		['not a url at all', '<unparsable REDIS_URL>'],
	])('%s', (configured, expected) => {
		expect(RedisAdapter.redactRedisUrl(configured)).toBe(expected)
	})

	it.each([
		`redis://user:${SECRET}@localhost:6379`,
		`redis://:${SECRET}@localhost:6379/1`,
		`rediss://user:${SECRET}@redis.example.com:6380`,
		`redis://user:${SECRET}@node1:6379,redis://node2:6379`,
		`redis://:${SECRET},${SECRET}@localhost:6379`,
		`redis://:${SECRET}@`,
		`redis://user:${encodeURIComponent(SECRET)}@localhost:6379`,
	])('never leaves the password in the output for %s', (configured) => {
		expect(RedisAdapter.redactRedisUrl(configured)).not.toContain(SECRET)
	})
})

describe('starting with a Redis URL that holds a password', () => {
	const configuredUrl = Config.REDIS_URL

	afterEach(() => {
		Config.REDIS_URL = configuredUrl
		vi.restoreAllMocks()
	})

	it('logs the redacted URL rather than the configured one', () => {
		Config.REDIS_URL = `redis://user:${SECRET}@localhost:6379`
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})

		RedisAdapter.createRedisClient()

		const logged = log.mock.calls.map((call) => call.join(' ')).join('\n')
		expect(logged).toContain('redis://***:***@localhost:6379')
		expect(logged).not.toContain(SECRET)
	})

	it('reports a malformed URL without repeating it', () => {
		Config.REDIS_URL = `redis://:${SECRET}@`
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})

		let thrown
		try {
			RedisAdapter.createRedisClient()
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)

		// `new URL()` hangs the value it was given on the error it throws, and
		// main() prints that error when the server fails to start
		expect(thrown.input).toBeUndefined()
		expect(inspect(thrown, { depth: null })).not.toContain(SECRET)

		expect(thrown.message).toBe('REDIS_URL is not a valid URL')

		const logged = log.mock.calls.map((call) => call.join(' ')).join('\n')
		expect(logged).toContain('<unparsable REDIS_URL>')
		expect(logged).not.toContain(SECRET)
	})
})
