/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import jwt from 'jsonwebtoken'
import { io } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createConfigMock } from './configMock.js'

vi.setConfig({ testTimeout: 20000 })

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: createConfigMock({
		NEXTCLOUD_URL: 'http://127.0.0.1:3011',
		PORT: '3011',
		HOST: '127.0.0.1',
		JWT_SECRET_KEY: 'secret',
		MAX_UPLOAD_FILE_SIZE: 4e6,
		COMPRESSION_ENABLED: false,
	}),
}))

const { default: ServerService } = await import('../../websocket_server/Services/ServerService.js')
const { default: Config } = await import('../../websocket_server/Utilities/ConfigUtility.js')
const { handshakeMaxMessageBytes } = await import('../../src/utils/collabServerLimits.ts')

const ROOM = '901'

function connect(userId) {
	return io(Config.NEXTCLOUD_URL, {
		transports: ['websocket'],
		reconnection: false,
		auth: { token: jwt.sign({ fileId: Number(ROOM), user: { id: userId, name: userId } }, Config.JWT_SECRET_KEY) },
	})
}

async function join(socket) {
	if (!socket.connected) {
		await new Promise((resolve) => socket.once('connect', resolve))
	}
	const designated = new Promise((resolve) => socket.once('sync-designate', resolve))
	socket.emit('join-room', ROOM)
	await designated
}

function imageMessage(fileSize) {
	const dataURL = `data:image/png;base64,${Buffer.alloc(fileSize, 7).toString('base64')}`
	const file = { mimeType: 'image/png', id: 'a'.repeat(40), dataURL, created: Date.now(), lastRetrieved: Date.now() }
	return new TextEncoder().encode(JSON.stringify({ type: 'IMAGE_ADD', payload: { file } }))
}

describe('Images up to MAX_UPLOAD_FILE_SIZE', () => {
	let server, alice, bob

	beforeAll(async () => {
		server = new ServerService()
		await server.start()
		alice = connect('alice')
		bob = connect('bob')
		await join(alice)
		await join(bob)
	})

	afterAll(async () => {
		alice?.disconnect()
		bob?.disconnect()
		await server?.gracefulShutdown()
	})

	it('reach the other users of the board', async () => {
		const received = new Promise((resolve) => bob.once('client-broadcast', (data) => resolve(data)))
		const message = imageMessage(Config.MAX_UPLOAD_FILE_SIZE)

		alice.emit('server-broadcast', ROOM, message, [])

		const data = await Promise.race([received, new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
		expect(alice.connected).toBe(true)
		expect(data?.byteLength).toBe(message.byteLength)
	})

	it('tell the client the socket message limit in the handshake', () => {
		expect(handshakeMaxMessageBytes(alice)).toBe(server.socketService.io.engine.opts.maxHttpBufferSize)
		expect(handshakeMaxMessageBytes(alice)).toBeGreaterThanOrEqual(imageMessage(Config.MAX_UPLOAD_FILE_SIZE).byteLength)
	})

	it('are reported in the status with the socket message limit that carries them', async () => {
		const response = await fetch(`${Config.NEXTCLOUD_URL}/status`)
		const { config } = await response.json()

		expect(config.maxUploadFileSizeBytes).toBe(4e6)
		expect(config.maxHttpBufferSizeBytes).toBe(server.socketService.io.engine.opts.maxHttpBufferSize)
		expect(config.maxHttpBufferSizeBytes).toBeGreaterThanOrEqual(imageMessage(4e6).byteLength)
	})
})
