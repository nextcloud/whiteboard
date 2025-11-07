/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Socket } from 'socket.io-client'
import type { AppState } from '@excalidraw/excalidraw/types/types'
import type { RecordingUser } from './recording'

export interface RecordingStoppedPayload {
	filePath: string
	recordingData: number[]
	uploadToken: string
	fileId: string
}

export interface RecordingAvailabilityPayload {
	available: boolean
	reason: string | null
}

export interface CollaboratorPayload {
	user: { id: string; name: string }
	pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
	button: 'down' | 'up'
	selectedElementIds: AppState['selectedElementIds']
}

export interface ViewportRequestPayload {
	requesterId: string
	requesterSocketId: string
}

export interface ServerToClientEvents {
	'init-room': () => void
	'room-user-change': (users: CollaboratorPayload[]) => void
	'user-joined': (data: { userId: string; userName: string; socketId: string; isSyncer: boolean }) => void
	'sync-designate': (data: { isSyncer: boolean }) => void
	'client-broadcast': (payload: ArrayBuffer, iv?: ArrayBuffer | number[]) => void
	'request-presenter-viewport': () => void

	// Recording
	'recording-started': () => void
	'recording-stopped': (payload: RecordingStoppedPayload) => void
	'recording-error': (message: string) => void
	'recording-availability': (payload: RecordingAvailabilityPayload) => void
	'user-started-recording': (payload: RecordingUser) => void
	'user-stopped-recording': (payload: RecordingUser) => void

	// Presentation
	'presentation-started': () => void
	'presentation-stopped': () => void
	'presentation-error': (message: string) => void
	'user-started-presenting': (payload: { userId: string; username: string }) => void
	'user-stopped-presenting': (payload: { userId: string; username: string }) => void
}

export interface ClientToServerEvents {
	'join-room': (roomId: string) => void
	'server-broadcast': (roomId: string, payload: ArrayBuffer | Uint8Array, iv: ArrayBuffer | number[] | []) => void
	'server-volatile-broadcast': (roomId: string, payload: Uint8Array) => void
	'image-get': (roomId: string, id: string) => void
	'request-presenter-viewport': (payload: { fileId: string }) => void

	// Recording
	'start-recording': (payload: { fileId: number; recordingUrl: string; uploadToken: string }) => void
	'stop-recording': (roomId: string) => void
	'check-recording-availability': () => void

	// Presentation
	'presentation-start': (payload: { fileId: string; userId: string }) => void
	'presentation-stop': (payload: { fileId: string }) => void
}

export type CollaborationSocket = Socket<ServerToClientEvents, ClientToServerEvents>
