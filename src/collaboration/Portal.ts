/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { io, type Socket } from 'socket.io-client'
import type { Collab } from './collab'
import type { AppState, BinaryFiles, Gesture } from '@excalidraw/excalidraw/types/types'
import axios from '@nextcloud/axios'
import { loadState } from '@nextcloud/initial-state'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	MouseLocation = 'MOUSE_LOCATION',
}

export class Portal {

	socket: Socket | null = null
	roomId: string
	collab: Collab
	publicSharingToken: string | null

	constructor(roomId: string, collab: Collab, publicSharingToken: string | null) {
		this.roomId = roomId
		this.collab = collab
		this.publicSharingToken = publicSharingToken
	}

	connectSocket = async () => {
		const collabBackendUrl = loadState('whiteboard', 'collabBackendUrl', '')
		await this.refreshJWT()
		const token = localStorage.getItem(`jwt-${this.roomId}`) || ''

		const url = new URL(collabBackendUrl)
		const path = url.pathname.replace(/\/$/, '') + '/socket.io'

		const socket = io(url.origin, {
			path,
			withCredentials: true,
			auth: {
				token,
			},
			transports: ['websocket'],
			timeout: 10000,
		}).connect()

		socket.on('connect_error', (error) => {
			if (
				error
				&& error.message
				&& !error.message.includes('Authentication error')
			) {
				this.handleConnectionError()
			}
		})

		socket.on('connect_timeout', () => {
			this.handleConnectionError()
		})

		this.open(socket)
	}

	handleConnectionError = () => {
		alert(
			'Failed to connect to the whiteboard server.',
		)
		OCA.Viewer?.close()
	}

	disconnectSocket = () => {
		if (this.socket) {
			this.socket.disconnect()
			localStorage.removeItem(`jwt-${this.roomId}`)
			console.log(
				`Disconnected from room ${this.roomId} and cleared JWT token`,
			)
		}
	}

	open(socket: Socket) {
		this.socket = socket

		this.socket?.on('connect_error', async (error) => {
			if (
				error
				&& error.message
				&& error.message.includes('Authentication error')
			) {
				await this.handleTokenRefresh()
			}
		})
		this.socket.on('read-only', () => this.handleReadOnlySocket())
		this.socket.on('init-room', () => this.handleInitRoom())
		this.socket.on(
			'room-user-change',
			(
				users: {
					user: {
						id: string
						name: string
					}
					socketId: string
					pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
					button: 'down' | 'up'
					selectedElementIds: AppState['selectedElementIds']
				}[],
			) => this.collab.updateCollaborators(users),
		)
		this.socket.on('client-broadcast', (data) =>
			this.handleClientBroadcast(data),
		)
	}

	async handleReadOnlySocket() {
		this.collab.makeBoardReadOnly()
	}

	async handleTokenRefresh() {
		const newToken = await this.refreshJWT()
		if (this.socket && newToken) {
			this.socket.auth.token = newToken
			this.socket?.connect()
		}
	}

	handleInitRoom() {
		this.socket?.emit('join-room', this.roomId)
		this.socket?.on('joined-data', (data) => {
			const remoteElements = JSON.parse(new TextDecoder().decode(data))
			const reconciledElements
				= this.collab._reconcileElements(remoteElements)
			this.collab.handleRemoteSceneUpdate(reconciledElements)
			this.collab.scrollToContent()
		})
		this.socket?.on('image-data', (file) => {
			this.collab.addFile(file)
		})
	}

	handleClientBroadcast(data: ArrayBuffer) {
		const decoded = JSON.parse(new TextDecoder().decode(data))
		switch (decoded.type) {
		case BroadcastType.SceneInit:
			this.handleSceneInit(decoded.payload.elements)
			break
		case BroadcastType.MouseLocation:
			this.collab.updateCursor(decoded.payload)
			break
		}
	}

	handleSceneInit(elements: readonly ExcalidrawElement[]) {
		const reconciledElements = this.collab._reconcileElements(elements)
		this.collab.handleRemoteSceneUpdate(reconciledElements)
	}

	async refreshJWT(): Promise<string | null> {
		try {
		  let url = `/index.php/apps/whiteboard/${this.roomId}/token`
		  if (this.publicSharingToken) {
				url += `?publicSharingToken=${encodeURIComponent(this.publicSharingToken)}`
		  }

		  const response = await axios.get(url, { withCredentials: true })

		  const token = response.data.token

		  console.log('token', token)

		  if (!token) throw new Error('No token received')

		  localStorage.setItem(`jwt-${this.roomId}`, token)

		  return token
		} catch (error) {
		  console.error('Error refreshing JWT:', error)
		  alert(error.message)
		  OCA.Viewer?.close()
		  return null
		}
	  }

	async _broadcastSocketData(
		data: {
			type: string
			payload: {
				elements?: readonly ExcalidrawElement[]
				socketId?: string
				pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
				button?: 'down' | 'up'
				selectedElementIds?: AppState['selectedElementIds']
				username?: string
			}
		},
		volatile: boolean = false,
		roomId?: string,
	) {
		const json = JSON.stringify(data)
		const encryptedBuffer = new TextEncoder().encode(json)
		this.socket?.emit(
			volatile ? 'server-volatile-broadcast' : 'server-broadcast',
			roomId ?? this.roomId,
			encryptedBuffer,
			[],
		)
	}

	async broadcastScene(
		updateType: string,
		elements: readonly ExcalidrawElement[],
	) {
		await this._broadcastSocketData({
			type: updateType,
			payload: { elements },
		})
	}

	async broadcastMouseLocation(payload: {
		pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
		button: 'down' | 'up'
		pointersMap: Gesture['pointers']
	}) {
		const data = {
			type: BroadcastType.MouseLocation,
			payload: {
				socketId: this.socket?.id,
				pointer: payload.pointer,
				button: payload.button || 'up',
				selectedElementIds:
					this.collab.excalidrawAPI.getAppState().selectedElementIds,
				username: this.socket?.id,
			},
		}

		await this._broadcastSocketData(data, true)
	}

	async sendImageFiles(files: BinaryFiles) {
		Object.values(files).forEach(file => {
			this.collab.addFile(file)
			this.socket?.emit('image-add', this.roomId, file.id, file)
		})
	}

}
