/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import os from 'os'

export default class SystemMonitor {

	constructor(socketManager, cachedTokenStorage) {
		this.socketManager = socketManager
		this.cachedTokenStorage = cachedTokenStorage
		this.startTime = Date.now()
	}

	getSystemOverview() {
		return {
			memoryUsage: this.getMemoryUsage(),
			cpuUsage: this.getCpuUsage(),
			systemInfo: this.getSystemInfo(),
			roomStats: this.getRoomStats(),
			cacheStats: this.getCacheStats(),
			uptime: this.getUptime(),
		}
	}

	getMemoryUsage() {
		const memUsage = process.memoryUsage()
		return {
			// Raw values in bytes
			rss: memUsage.rss,
			heapTotal: memUsage.heapTotal,
			heapUsed: memUsage.heapUsed,
			external: memUsage.external,
			arrayBuffers: memUsage.arrayBuffers,
			systemTotal: os.totalmem(),
			systemFree: os.freemem(),
			// Formatted values for display
			rssFormatted: this.formatBytes(memUsage.rss),
			heapTotalFormatted: this.formatBytes(memUsage.heapTotal),
			heapUsedFormatted: this.formatBytes(memUsage.heapUsed),
			externalFormatted: this.formatBytes(memUsage.external),
			arrayBuffersFormatted: this.formatBytes(memUsage.arrayBuffers),
			systemTotalFormatted: this.formatBytes(os.totalmem()),
			systemFreeFormatted: this.formatBytes(os.freemem()),
		}
	}

	getCpuUsage() {
		return {
			cpuCount: os.cpus().length,
			loadAvg: os.loadavg(),
		}
	}

	getSystemInfo() {
		return {
			platform: os.platform(),
			arch: os.arch(),
			nodeVersion: process.version,
		}
	}

	getRoomStats() {
		if (!this.socketManager || !this.socketManager.io) {
			return { error: 'Socket manager not available' }
		}

		try {
			const io = this.socketManager.io

			// Get all rooms
			const rooms = Array.from(io.sockets.adapter.rooms.keys())
			// Filter out socket IDs (which are also treated as rooms)
			const socketIds = Array.from(io.sockets.sockets.keys())
			const actualRooms = rooms.filter(room => !socketIds.includes(room))

			// Get detailed room stats
			const roomStats = {
				connectedClients: io.sockets.sockets.size,
				activeRooms: actualRooms.length,
				roomDetails: [],
			}

			// Get users per room
			for (const roomId of actualRooms) {
				const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
				const uniqueUsers = new Set()

				// Count unique users in the room
				for (const socketId of roomSockets) {
					try {
						// Note: We're not awaiting this since we're just collecting stats
						// and don't want to slow down the metrics collection
						this.socketManager.socketDataStorage.get(socketId)
							.then(socketData => {
								if (socketData && socketData.user && socketData.user.id) {
									uniqueUsers.add(socketData.user.id)
								}
							})
							.catch(() => {})
					} catch (e) {
						// Ignore errors in metrics collection
					}
				}

				roomStats.roomDetails.push({
					roomId,
					totalSockets: roomSockets.length,
					uniqueUsers: uniqueUsers.size,
				})
			}

			return roomStats
		} catch (error) {
			console.error('Error getting room stats:', error)
			return { error: 'Failed to get room statistics' }
		}
	}

	getCacheStats() {
		if (!this.cachedTokenStorage) {
			return { error: 'Token storage not available' }
		}

		try {
			// Get stats from the token storage
			const strategy = this.cachedTokenStorage.strategy
			const stats = {
				type: strategy.constructor.name,
				size: 0,
				maxSize: 0,
			}

			// For LRU cache
			if (strategy.cache) {
				stats.size = strategy.cache.size
				stats.maxSize = strategy.cache.max || 0
			}

			// For Redis
			if (strategy.redisClient) {
				stats.connected = strategy.redisClient.isOpen
				stats.storageType = 'redis'
			}

			return stats
		} catch (error) {
			console.error('Error getting cache stats:', error)
			return { error: 'Failed to get cache statistics' }
		}
	}

	getUptime() {
		const uptime = Date.now() - this.startTime
		const seconds = Math.floor(uptime / 1000)
		const processUptime = process.uptime()
		const systemUptime = os.uptime()

		return {
			// Raw values
			ms: uptime,
			seconds,
			processSeconds: processUptime,
			systemSeconds: systemUptime,
			// Formatted values
			formatted: this.formatUptime(seconds),
			processFormatted: this.formatUptime(processUptime),
			systemFormatted: this.formatUptime(systemUptime),
		}
	}

	formatBytes(bytes) {
		if (bytes === 0) return '0 Bytes'
		const k = 1024
		const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
	}

	formatUptime(seconds) {
		const days = Math.floor(seconds / 86400)
		const hours = Math.floor((seconds % 86400) / 3600)
		const minutes = Math.floor((seconds % 3600) / 60)
		const secs = Math.floor(seconds % 60)

		let result = ''
		if (days > 0) result += `${days}d `
		if (hours > 0 || days > 0) result += `${hours}h `
		if (minutes > 0 || hours > 0 || days > 0) result += `${minutes}m `
		result += `${secs}s`

		return result
	}

}
