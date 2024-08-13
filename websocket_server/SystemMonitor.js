/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class SystemMonitor {

	constructor(storageManager) {
		this.storageManager = storageManager
	}

	getSystemOverview() {
		const rooms = this.storageManager.getRooms()
		return {
			memoryUsage: this.getMemoryUsage(),
			roomStats: this.getRoomStats(rooms),
			cacheInfo: this.getCacheInfo(rooms),
			roomsData: this.getRoomsData(rooms),
		}
	}

	getMemoryUsage() {
		const memUsage = process.memoryUsage()
		return {
			rss: this.formatBytes(memUsage.rss),
			heapTotal: this.formatBytes(memUsage.heapTotal),
			heapUsed: this.formatBytes(memUsage.heapUsed),
			external: this.formatBytes(memUsage.external),
			arrayBuffers: this.formatBytes(memUsage.arrayBuffers),
		}
	}

	getRoomStats(rooms) {
		return {
			activeRooms: rooms.size,
			totalUsers: Array.from(rooms.values()).reduce((sum, room) => sum + Object.keys(room.users).length, 0),
			totalDataSize: this.formatBytes(Array.from(rooms.values()).reduce((sum, room) => sum + (room.data ? JSON.stringify(room.data).length : 0), 0)),
		}
	}

	getRoomsData(rooms) {
		return Array.from(rooms.entries()).map(([roomId, room]) => ({
			id: roomId,
			users: Object.keys(room.users),
			lastEditedUser: room.lastEditedUser,
			lastActivity: new Date(room.lastActivity).toISOString(),
			dataSize: this.formatBytes(JSON.stringify(room.data).length),
			data: room.data, // Be cautious with this if the data is very large
		}))
	}

	getCacheInfo(rooms) {
		return {
			size: rooms.size,
			maxSize: rooms.max,
			keys: Array.from(rooms.keys()),
			recentlyUsed: Array.from(rooms.keys()).slice(0, 10), // Show 10 most recently used
		}
	}

	formatBytes(bytes) {
		if (bytes === 0) return '0 Bytes'
		const k = 1024
		const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
	}

}
