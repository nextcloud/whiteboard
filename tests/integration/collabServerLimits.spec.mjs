/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWhiteboardConfigStore } from '../../src/stores/useWhiteboardConfigStore.ts'
import { broadcastImage, currentLargestSharedFileBytes, filesFitCollabMessages, handshakeMaxMessageBytes, imageOptionsFor, largestSharedFileBytes } from '../../src/utils/collabServerLimits.ts'
import GeneralUtility from '../../websocket_server/Utilities/GeneralUtility.js'

function imageFile(size, id = 'f'.repeat(40)) {
	return {
		mimeType: 'image/png',
		id,
		dataURL: `data:image/png;base64,${Buffer.alloc(size, 7).toString('base64')}`,
		created: 1762400000000,
		lastRetrieved: 1762400000000,
	}
}

function socket() {
	return { emit: vi.fn() }
}

const setLimit = (bytes) => useWhiteboardConfigStore.getState().setCollabMaxMessageBytes(bytes)

describe('collaboration server limits', () => {
	afterEach(() => {
		setLimit(null)
	})

	it.each([2e6, 4e6, 10e6, 50e6])('sends a file of MAX_UPLOAD_FILE_SIZE %d in one message the server accepts', (maxUploadFileSize) => {
		const maxMessageBytes = GeneralUtility.maxSocketMessageSize(maxUploadFileSize)
		setLimit(maxMessageBytes)
		const target = socket()

		expect(largestSharedFileBytes(maxMessageBytes)).toBeGreaterThanOrEqual(maxUploadFileSize)
		expect(broadcastImage(target, '42', imageFile(maxUploadFileSize))).toBe(true)
		expect(target.emit.mock.calls[0][2].byteLength).toBeLessThanOrEqual(maxMessageBytes)
	})

	it('allows only files that fit the message limit of servers before this fix until the connection tells its limit', () => {
		const oldLimit = 2e6 + 1e6
		const target = socket()

		expect(filesFitCollabMessages([imageFile(largestSharedFileBytes(oldLimit))])).toBe(true)
		expect(filesFitCollabMessages({ large: imageFile(largestSharedFileBytes(oldLimit) + 10000) })).toBe(false)
		expect(broadcastImage(target, '42', imageFile(largestSharedFileBytes(oldLimit) + 10000))).toBe(false)
		expect(target.emit).not.toHaveBeenCalled()
		expect(imageOptionsFor(null)).toEqual({ maxFileSizeBytes: largestSharedFileBytes(oldLimit) })
	})

	it('gives the largest file of the current connection, or of the fallback limit while it is unknown', () => {
		expect(currentLargestSharedFileBytes()).toBe(largestSharedFileBytes(3e6))
		setLimit(GeneralUtility.maxSocketMessageSize(1e6))
		expect(currentLargestSharedFileBytes()).toBe(largestSharedFileBytes(GeneralUtility.maxSocketMessageSize(1e6)))
		// The largest file it gives still fits a message.
		expect(filesFitCollabMessages([imageFile(currentLargestSharedFileBytes())])).toBe(true)
	})

	it('limits images in Excalidraw only below its own 4 MB limit', () => {
		expect(imageOptionsFor(GeneralUtility.maxSocketMessageSize(2e6))).toEqual({ maxFileSizeBytes: largestSharedFileBytes(GeneralUtility.maxSocketMessageSize(2e6)) })
		expect(imageOptionsFor(GeneralUtility.maxSocketMessageSize(10e6))).toBeUndefined()
	})

	it('checks every file and ignores entries without data', () => {
		setLimit(10000)

		expect(filesFitCollabMessages(undefined)).toBe(true)
		expect(filesFitCollabMessages({ small: imageFile(10), empty: { id: 'empty' } })).toBe(true)
		expect(filesFitCollabMessages({ small: imageFile(10), large: imageFile(20000) })).toBe(false)
	})

	it('measures a message exactly without encoding its data URL', () => {
		const file = imageFile(3000)
		const exact = new TextEncoder().encode(JSON.stringify({ type: 'IMAGE_ADD', payload: { file } })).byteLength

		setLimit(exact)
		expect(filesFitCollabMessages([file])).toBe(true)
		expect(broadcastImage(socket(), '42', file)).toBe(true)
		setLimit(exact - 1)
		expect(filesFitCollabMessages([file])).toBe(false)
		expect(broadcastImage(socket(), '42', file)).toBe(false)
	})

	it('sends images as IMAGE_ADD messages', () => {
		const target = socket()
		const file = imageFile(10)

		expect(broadcastImage(target, '42', file)).toBe(true)
		const [event, room, message, iv] = target.emit.mock.calls[0]
		expect([event, room, iv]).toEqual(['server-broadcast', '42', []])
		expect(JSON.parse(new TextDecoder().decode(message))).toEqual({ type: 'IMAGE_ADD', payload: { file } })
	})

	it('forgets the limit when the board is reset', () => {
		setLimit(9000000)
		useWhiteboardConfigStore.getState().resetStore()

		expect(useWhiteboardConfigStore.getState().collabMaxMessageBytes).toBeNull()
	})

	it('reads the limit of the connection from the handshake', () => {
		expect(handshakeMaxMessageBytes({ io: { engine: { _maxPayload: 3666667 } } })).toBe(3666667)
		expect(handshakeMaxMessageBytes({ io: { engine: { _maxPayload: -1 } } })).toBeNull()
		expect(handshakeMaxMessageBytes({ io: {} })).toBeNull()
	})
})
