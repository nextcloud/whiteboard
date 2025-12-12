import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import { createConfigMock } from './configMock.js'
import ServerManagerModule from '../../websocket_server/Services/ServerService.js'
import ConfigModule from '../../websocket_server/Utilities/ConfigUtility.js'

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({
		NEXTCLOUD_URL: 'http://127.0.0.1:3008',
		PORT: '3008',
		HOST: '127.0.0.1',
		METRICS_TOKEN: 'secret',
		USE_TLS: false,
		STORAGE_STRATEGY: 'lru',
		MAX_UPLOAD_FILE_SIZE: 2e6,
		CACHED_TOKEN_TTL: 5 * 60 * 1000,
		COMPRESSION_ENABLED: false,
	}),
}))

const Config = ConfigModule
const ServerService = ServerManagerModule

describe('Metrics endpoint', () => {
	let serverManager

	beforeAll(async () => {
		serverManager = new ServerService()
		await serverManager.start()
	})

	afterAll(async () => {
		await serverManager.gracefulShutdown()
	})

	it('should work with bearer auth', async () => {
		const response = await axios.get(`${Config.NEXTCLOUD_URL}/metrics`, {
			headers: {
				Authorization: `Bearer ${Config.METRICS_TOKEN}`,
			},
		})
		expect(response.status).toBe(200)
		// Check for memory metrics
		expect(response.data).toContain('whiteboard_memory_usage{type="rss"}')
		// Check for room metrics
		expect(response.data).toContain('whiteboard_room_stats{stat="connectedClients"}')
		expect(response.data).toContain('whiteboard_room_stats{stat="activeRooms"}')
		// Check for cache metrics
		expect(response.data).toContain('whiteboard_cache_stats{stat="size"}')
		// Check for socket.io metrics
		expect(response.data).toContain('socket_io_connected')
	})

	it('should work with token param', async () => {
		const response = await axios.get(`${Config.NEXTCLOUD_URL}/metrics?token=${Config.METRICS_TOKEN}`)
		expect(response.status).toBe(200)
		expect(response.data).toContain('whiteboard_room_stats{stat="activeRooms"}')
		expect(response.data).toContain('whiteboard_memory_usage')
		expect(response.data).toContain('whiteboard_cache_stats')
	})

	it('Not return on invalid auth', async () => {
		try {
			await axios.get(`${Config.NEXTCLOUD_URL}/metrics`, {
				headers: {
					Authorization: 'Bearer wrongtoken',
				},
			})
			expect(true).toBe(false)
		} catch (error) {
			expect(error.response.status).toBe(403)
		}
	})
})
