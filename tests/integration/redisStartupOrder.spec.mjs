/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SocketService from '../../websocket_server/Services/SocketService.js'
import StorageService from '../../websocket_server/Services/StorageService.js'

/**
 * A Redis client that records the commands it is asked to run.
 *
 * @param {string[]} commands the list every call is appended to
 * @return {object} a stand-in for a redis client
 */
function recordingClient(commands) {
	const record = (name) => () => {
		commands.push(name)
		return Promise.resolve(null)
	}

	return {
		isOpen: true,
		set: record('set'),
		get: record('get'),
		del: record('del'),
		expire: record('expire'),
		hGetAll: record('hGetAll'),
		hSet: record('hSet'),
		async* scanIterator() {
			commands.push('scanIterator')
			yield* []
		},
	}
}

/**
 * Build a socket service whose Redis connection is still being established.
 *
 * @param {Promise} redisReady the promise the connection is behind
 * @param {string[]} commands the list Redis calls are recorded into
 * @return {object} the server and the service, both to be closed by the caller
 */
function buildService(redisReady, commands) {
	const server = http.createServer()
	const service = new SocketService(
		server,
		StorageService.create('in-mem'),
		StorageService.create('in-mem'),
		recordingClient(commands),
		redisReady,
	)

	return { server, service }
}

describe('starting while Redis is still connecting', () => {
	let started = null

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		// the streams adapter reads from Redis in a loop of its own, which is
		// not what is under test here
		vi.spyOn(SocketService.prototype, 'setupAdapter').mockResolvedValue(undefined)
	})

	afterEach(async () => {
		if (started) {
			await started.service.clusterService.stop()
			started.service.io.close()
			started.server.close()
			started = null
		}
		vi.restoreAllMocks()
	})

	it('runs no command until the connection is up', async () => {
		const commands = []
		let connected
		const redisReady = new Promise((resolve) => {
			connected = resolve
		})

		started = buildService(redisReady, commands)

		// give init() every chance to run ahead of the connection
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
		expect(commands).toEqual([])

		connected()
		await started.service.ready

		// the heartbeat is written once as soon as the cluster service starts
		expect(commands).toContain('set')
	})

	it('fails to start when the connection fails', async () => {
		const commands = []
		const redisReady = Promise.reject(new Error('Redis is not listening'))

		started = buildService(redisReady, commands)

		await expect(started.service.ready).rejects.toThrow('Redis is not listening')
		expect(commands).toEqual([])
	})
})
