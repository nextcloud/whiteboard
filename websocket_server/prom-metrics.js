/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { register, Gauge } from 'prom-client'
import { getSystemOverview } from './monitoring.js'

const memoryUsageGauge = new Gauge({
	name: 'whiteboard_memory_usage',
	help: 'Memory usage of the server',
	labelNames: ['type'],
})

const roomStatsGauge = new Gauge({
	name: 'whiteboard_room_stats',
	help: 'Room statistics',
	labelNames: ['stat'],
})

const cacheInfoGauge = new Gauge({
	name: 'whiteboard_cache_info',
	help: 'Cache information',
	labelNames: ['info'],
})

export function updatePrometheusMetrics(rooms) {
	const overview = getSystemOverview(rooms)

	Object.entries(overview.memoryUsage).forEach(([key, value]) => {
		memoryUsageGauge.set({ type: key }, parseFloat(value) || 0)
	})

	roomStatsGauge.set({ stat: 'activeRooms' }, Number(overview.roomStats.activeRooms) || 0)
	roomStatsGauge.set({ stat: 'totalUsers' }, Number(overview.roomStats.totalUsers) || 0)
	roomStatsGauge.set({ stat: 'totalDataSize' }, parseFloat(overview.roomStats.totalDataSize) || 0)

	cacheInfoGauge.set({ info: 'size' }, Number(overview.cacheInfo.size) || 0)
	cacheInfoGauge.set({ info: 'maxSize' }, Number(overview.cacheInfo.maxSize) || 0)
}

export { register }
