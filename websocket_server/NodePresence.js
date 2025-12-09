/* eslint-disable no-console */
/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class NodePresence {

	constructor(redisClient, {
		nodeId,
		ttlMs = 15000,
		keyPrefix = 'node:',
	} = {}) {
		this.redisClient = redisClient
		this.nodeId = nodeId
		this.ttlMs = ttlMs
		this.keyPrefix = keyPrefix
		this.heartbeatKey = this.buildKey(this.nodeId)
		this.interval = null
	}

	buildKey(nodeId) {
		return `${this.keyPrefix}${nodeId}:heartbeat`
	}

	isClientClosedError(error) {
		return error?.name === 'ClientClosedError' || error?.message?.includes('The client is closed')
	}

	shouldUseRedis() {
		return !!this.redisClient
	}

	async start() {
		if (!this.shouldUseRedis() || this.interval) {
			return
		}

		const ttlSeconds = Math.max(1, Math.ceil(this.ttlMs / 1000))
		const writeHeartbeat = async () => {
			try {
				await this.redisClient.set(this.heartbeatKey, 'alive', { EX: ttlSeconds })
			} catch (error) {
				if (this.isClientClosedError(error)) {
					return
				}
				console.error('Failed to write heartbeat:', error)
			}
		}

		await writeHeartbeat()
		this.interval = setInterval(writeHeartbeat, Math.max(1000, this.ttlMs / 3))
	}

	async stop() {
		if (this.interval) {
			clearInterval(this.interval)
			this.interval = null
		}
		if (this.shouldUseRedis()) {
			try {
				await this.redisClient.del(this.heartbeatKey)
			} catch (error) {
				if (this.isClientClosedError(error)) {
					return
				}
				console.error('Failed to remove heartbeat key:', error)
			}
		}
	}

	async isAlive(nodeId) {
		if (!this.shouldUseRedis() || !nodeId) {
			return true
		}
		try {
			const exists = await this.redisClient.exists(this.buildKey(nodeId))
			return exists === 1
		} catch (error) {
			if (this.isClientClosedError(error)) {
				return true
			}
			console.error('Failed to check node heartbeat:', error)
			return true
		}
	}

}
