/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { register, Gauge } from 'prom-client'

export default class PrometheusDataService {

	constructor(systemMonitor) {
		this.systemMonitor = systemMonitor
		this.initializeMetrics()
		this.lastUpdateTime = Date.now()
	}

	initializeMetrics() {
		this.memoryUsageGauge = new Gauge({
			name: 'whiteboard_memory_usage',
			help: 'Memory usage of the server in bytes',
			labelNames: ['type'],
		})

		this.cpuUsageGauge = new Gauge({
			name: 'whiteboard_cpu_usage',
			help: 'CPU usage information',
			labelNames: ['type'],
		})

		this.roomStatsGauge = new Gauge({
			name: 'whiteboard_room_stats',
			help: 'Room statistics',
			labelNames: ['stat'],
		})

		this.roomDetailsGauge = new Gauge({
			name: 'whiteboard_room_details',
			help: 'Detailed room statistics',
			labelNames: ['room_id', 'metric'],
		})

		this.cacheStatsGauge = new Gauge({
			name: 'whiteboard_cache_stats',
			help: 'Token cache statistics',
			labelNames: ['stat'],
		})

		this.uptimeGauge = new Gauge({
			name: 'whiteboard_uptime_seconds',
			help: 'Server uptime in seconds',
		})
	}

	updateMetrics() {
		try {
			const overview = this.systemMonitor.getSystemOverview()
			const now = Date.now()
			const updateInterval = (now - this.lastUpdateTime) / 1000
			this.lastUpdateTime = now

			Object.entries(overview.memoryUsage).forEach(([key, value]) => {
				if (typeof value === 'number') {
					this.memoryUsageGauge.set({ type: key }, value)
				}
			})

			if (overview.cpuUsage) {
				this.cpuUsageGauge.set({ type: 'cpuCount' }, overview.cpuUsage.cpuCount)
				overview.cpuUsage.loadAvg.forEach((load, index) => {
					this.cpuUsageGauge.set({ type: `loadAvg${index + 1}` }, load)
				})
			}

			if (overview.roomStats && !overview.roomStats.error) {
				// Overall room stats
				this.roomStatsGauge.set({ stat: 'connectedClients' }, overview.roomStats.connectedClients || 0)
				this.roomStatsGauge.set({ stat: 'activeRooms' }, overview.roomStats.activeRooms || 0)

				// Detailed room stats
				if (overview.roomStats.roomDetails && Array.isArray(overview.roomStats.roomDetails)) {
					// Clear previous room details metrics to avoid stale data
					this.roomDetailsGauge.reset()

					overview.roomStats.roomDetails.forEach(room => {
						if (room.roomId) {
							this.roomDetailsGauge.set({ room_id: room.roomId, metric: 'totalSockets' }, room.totalSockets || 0)
							this.roomDetailsGauge.set({ room_id: room.roomId, metric: 'uniqueUsers' }, room.uniqueUsers || 0)
						}
					})
				}
			}

			if (overview.cacheStats && !overview.cacheStats.error) {
				this.cacheStatsGauge.set({ stat: 'size' }, overview.cacheStats.size || 0)
				this.cacheStatsGauge.set({ stat: 'maxSize' }, overview.cacheStats.maxSize || 0)

				// Set cache type as a label with value 1
				if (overview.cacheStats.type) {
					this.cacheStatsGauge.set({ stat: `type_${overview.cacheStats.type}` }, 1)
				}

				// Set Redis connection status if available
				if (overview.cacheStats.connected !== undefined) {
					this.cacheStatsGauge.set({ stat: 'redisConnected' }, overview.cacheStats.connected ? 1 : 0)
				}
			}

			if (overview.uptime && overview.uptime.seconds) {
				this.uptimeGauge.set(overview.uptime.seconds)
			}

			console.log(`Metrics updated (interval: ${updateInterval.toFixed(2)}s)`)
		} catch (error) {
			console.error('Error updating metrics:', error)
		}
	}

	getRegister() {
		return register
	}

}
