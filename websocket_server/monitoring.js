/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function getSystemOverview(rooms) {
	return {
		memoryUsage: getMemoryUsage(),
		roomStats: getRoomStats(rooms),
		cacheInfo: getCacheInfo(rooms),
		roomsData: getRoomsData(rooms),
	}
}

function getMemoryUsage() {
	const memUsage = process.memoryUsage()
	return {
		rss: formatBytes(memUsage.rss),
		heapTotal: formatBytes(memUsage.heapTotal),
		heapUsed: formatBytes(memUsage.heapUsed),
		external: formatBytes(memUsage.external),
		arrayBuffers: formatBytes(memUsage.arrayBuffers),
	}
}

function getRoomStats(rooms) {
	return {
		activeRooms: rooms.size,
		totalUsers: Array.from(rooms.values()).reduce((sum, room) => sum + Object.keys(room.users).length, 0),
		totalDataSize: formatBytes(Array.from(rooms.values()).reduce((sum, room) => sum + (room.data ? JSON.stringify(room.data).length : 0), 0)),
	}
}

function getRoomsData(rooms) {
	return Array.from(rooms.entries()).map(([roomId, room]) => ({
		id: roomId,
		users: Object.keys(room.users),
		lastEditedUser: room.lastEditedUser,
		lastActivity: new Date(room.lastActivity).toISOString(),
		dataSize: formatBytes(JSON.stringify(room.data).length),
		data: room.data, // Be cautious with this if the data is very large
	}))
}

function getCacheInfo(rooms) {
	return {
		size: rooms.size,
		maxSize: rooms.max,
		keys: Array.from(rooms.keys()),
		recentlyUsed: Array.from(rooms.keys()).slice(0, 10), // Show 10 most recently used
	}
}

function formatBytes(bytes) {
	if (bytes === 0) return '0 Bytes'
	const k = 1024
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
