import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import { createConfigMock } from './configMock.js'
import ServerManagerModule from '../../websocket_server/ServerManager.js'
import ConfigModule from '../../websocket_server/Config.js'

vi.mock('../../websocket_server/Config.js', () => ({
	default: createConfigMock({
		NEXTCLOUD_URL: 'http://localhost:3008',
		NEXTCLOUD_WEBSOCKET_URL: 'http://localhost:3008',
		PORT: '3008',
		METRICS_TOKEN: 'secret',
	}),
}))

const Config = ConfigModule
const ServerManager = ServerManagerModule

describe('Metrics endpoint', () => {
	let serverManager

	beforeAll(async () => {
		serverManager = new ServerManager()
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
		expect(response.data).toContain('whiteboard_memory_usage{type="rss"}')
		expect(response.data).toContain('whiteboard_room_stats{stat="activeRooms"}')
		expect(response.data).toContain('whiteboard_room_stats{stat="totalUsers"}')
		expect(response.data).toContain('whiteboard_room_stats{stat="totalDataSize"}')
		expect(response.data).toContain('whiteboard_cache_info{info="size"}')
		expect(response.data).toContain('socket_io_connected')
	})

	it('should work with token param', async () => {
		const response = await axios.get(`${Config.NEXTCLOUD_URL}/metrics?token=${Config.METRICS_TOKEN}`)
		expect(response.status).toBe(200)
		expect(response.data).toContain('whiteboard_room_stats{stat="activeRooms"}')
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
