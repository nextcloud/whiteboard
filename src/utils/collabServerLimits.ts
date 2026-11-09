/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BinaryFileData, BinaryFiles } from '@nextcloud/excalidraw/types'
import type { CollaborationSocket } from '../types/collaboration.ts'

import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'

// Excalidraw's own limit for an image after it scaled the image down
const EXCALIDRAW_MAX_IMAGE_BYTES = 4 * 1024 * 1024

// Limit of a collaboration server with the default MAX_UPLOAD_FILE_SIZE that sized its messages
// without base64, used until the connection tells the real one
const DEFAULT_MAX_MESSAGE_BYTES = 3e6

// Room for the JSON around the data URL of a file in an image message
const IMAGE_MESSAGE_OVERHEAD_BYTES = 4096

/**
 * Largest message the collaboration server accepts on this connection, from the
 * Engine.IO handshake, which every server version sends.
 *
 * @param socket - Connected socket of the board
 * @return Bytes, or null when the handshake did not tell
 */
export function handshakeMaxMessageBytes(socket: CollaborationSocket): number | null {
	const maxPayload = (socket.io.engine as unknown as { _maxPayload?: number } | undefined)?._maxPayload
	return maxPayload && maxPayload > 0 ? maxPayload : null
}

function maxMessageBytes(): number {
	return useWhiteboardConfigStore.getState().collabMaxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
}

function imageMessage(file: BinaryFileData): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ type: 'IMAGE_ADD', payload: { file } }))
}

// Size of the message without encoding the data URL, which is base64 and needs no escaping
function imageMessageBytes(file: BinaryFileData): number {
	return imageMessage({ ...file, dataURL: '' as BinaryFileData['dataURL'] }).byteLength + file.dataURL.length
}

/**
 * Largest file that still fits into one socket message of the given size.
 * Files travel as base64 data URLs inside JSON.
 *
 * @param maxMessageBytes - Largest message the collaboration server accepts
 */
export function largestSharedFileBytes(maxMessageBytes: number): number {
	return Math.floor((maxMessageBytes - IMAGE_MESSAGE_OVERHEAD_BYTES) * 3 / 4)
}

/**
 * Largest file the collaboration server passes on over the board's current
 * connection, with the default limit used until the connection tells it.
 */
export function currentLargestSharedFileBytes(): number {
	return largestSharedFileBytes(maxMessageBytes())
}

/**
 * Image options for Excalidraw that refuse images the collaboration server
 * cannot pass on to the other users.
 *
 * @param collabMaxMessageBytes - Limit of the connection, null while unknown
 */
export function imageOptionsFor(collabMaxMessageBytes: number | null): { maxFileSizeBytes: number } | undefined {
	const maxFileSizeBytes = largestSharedFileBytes(collabMaxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
	return maxFileSizeBytes < EXCALIDRAW_MAX_IMAGE_BYTES ? { maxFileSizeBytes } : undefined
}

/**
 * Whether the collaboration server can pass all these files on to the other users.
 *
 * @param files - Files about to be added to the board
 */
export function filesFitCollabMessages(files: BinaryFiles | BinaryFileData[] | undefined): boolean {
	const limit = maxMessageBytes()
	return Object.values(files ?? {}).every((file) => !file?.dataURL || imageMessageBytes(file) <= limit)
}

/**
 * Send an image to the other users of the board, unless it is larger than
 * the collaboration server accepts, which would close the connection.
 *
 * @param socket - Socket of the board
 * @param roomId - Room of the board
 * @param file - The image
 * @return Whether the image was sent
 */
export function broadcastImage(socket: CollaborationSocket, roomId: string, file: BinaryFileData): boolean {
	const limit = maxMessageBytes()
	if (imageMessageBytes(file) > limit) {
		return false
	}
	const message = imageMessage(file)
	if (message.byteLength > limit) {
		return false
	}
	socket.emit('server-broadcast', roomId, message, [])
	return true
}
