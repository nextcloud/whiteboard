/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { register, Gauge } from 'prom-client'

export default class PrometheusDataManager {

	constructor(systemMonitor) {
		this.systemMonitor = systemMonitor
		this.initializeGauges()
	}

	initializeGauges() {
		this.memoryUsageGauge = new Gauge({
			name: 'whiteboard_memory_usage',
			help: 'Memory usage of the server',
			labelNames: ['type'],
		})

		this.roomStatsGauge = new Gauge({
			name: 'whiteboard_room_stats',
			help: 'Room statistics',
			labelNames: ['stat'],
		})

		this.cacheInfoGauge = new Gauge({
			name: 'whiteboard_cache_info',
			help: 'Cache information',
			labelNames: ['info'],
		})
	}

	updateMetrics() {
		const overview = this.systemMonitor.getSystemOverview()

		Object.entries(overview.memoryUsage).forEach(([key, value]) => {
			this.memoryUsageGauge.set({ type: key }, parseFloat(value) || 0)
		})

		this.roomStatsGauge.set({ stat: 'activeRooms' }, Number(overview.roomStats.activeRooms) || 0)
		this.roomStatsGauge.set({ stat: 'totalUsers' }, Number(overview.roomStats.totalUsers) || 0)
		this.roomStatsGauge.set({ stat: 'totalDataSize' }, parseFloat(overview.roomStats.totalDataSize) || 0)

		this.cacheInfoGauge.set({ info: 'size' }, Number(overview.cacheInfo.size) || 0)
		this.cacheInfoGauge.set({ info: 'maxSize' }, Number(overview.cacheInfo.maxSize) || 0)
	}

	getRegister() {
		return register
	}

}
