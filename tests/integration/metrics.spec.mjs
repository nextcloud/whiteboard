import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import ServerManager from '../../websocket_server/ServerManager.js'

const SERVER_URL = 'http://localhost:3008'
const SECRET = 'secret'

vi.stubEnv('METRICS_TOKEN', SECRET)

describe('Metrics endpoint', () => {
	let serverManager

	beforeAll(async () => {
		serverManager = new ServerManager({
			port: 3008,
			storageStrategy: 'lru',
		})

		serverManager.start()
	})

	afterAll(async () => {
		await serverManager.server.close()
	})

	it('should work with bearer auth', async () => {
		const response = await axios.get(`${SERVER_URL}/metrics`, {
			headers: {
				Authorization: `Bearer ${SECRET}`,
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
		const response = await axios.get(`${SERVER_URL}/metrics?token=${SECRET}`)
		expect(response.status).toBe(200)
		expect(response.data).toContain('whiteboard_room_stats{stat="activeRooms"}')
	})

	it('Not return on invalid auth', async () => {
		try {
			await axios.get(`${SERVER_URL}/metrics`, {
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
