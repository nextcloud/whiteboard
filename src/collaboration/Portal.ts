/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { io, type Socket } from 'socket.io-client'
import type { Collab } from './collab'
import type {
	AppState,
	BinaryFiles,
	Gesture,
} from '@excalidraw/excalidraw/types/types'
import { loadState } from '@nextcloud/initial-state'
import { useJWTStore } from '../stores/jwtStore'
import { useNetworkStore } from '../stores/networkStore'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	MouseLocation = 'MOUSE_LOCATION',
}

export class Portal {

	socket: Socket | null = null
	roomId: string
	collab: Collab
	publicSharingToken: string | null
	private jwtStore = useJWTStore.getState()
	private networkStore = useNetworkStore.getState()

	constructor(
		roomId: string,
		collab: Collab,
		publicSharingToken: string | null,
	) {
		this.roomId = roomId
		this.collab = collab
		this.publicSharingToken = publicSharingToken

		useJWTStore.subscribe((state) => {
			this.jwtStore = state
		})

		useNetworkStore.subscribe((state) => {
			this.networkStore = state
		})
	}

	connectSocket = async () => {
		try {
			const collabBackendUrl = loadState(
				'whiteboard',
				'collabBackendUrl',
				'',
			)
			const token = await this.jwtStore.getJWT(
				this.roomId,
				this.roomId,
				this.publicSharingToken,
			)

			if (!token) {
				console.warn(
					'No JWT token available, operating in offline mode',
				)
				this.networkStore.setOfflineMode(true)
				return
			}

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
		} catch (error) {
			console.error('Failed to connect to socket:', error)
			this.networkStore.setOfflineMode(true)
		}
	}

	handleConnectionError = () => {
		console.warn(
			'Failed to connect to the whiteboard server, switching to offline mode',
		)
		this.networkStore.setOfflineMode(true)
		// Don't close the viewer, allow user to continue in offline mode
	}

	disconnectSocket = () => {
		if (this.socket) {
			this.socket.disconnect()
			this.jwtStore.clearJWT(this.roomId)
			console.log(
				`Disconnected from room ${this.roomId} and cleared JWT token`,
			)
		}
	}

	open(socket: Socket) {
		this.socket = socket
		this.networkStore.setOfflineMode(false)

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
		const newToken = await this.jwtStore.refreshJWT(
			this.roomId,
			this.roomId,
			this.publicSharingToken,
		)

		if (this.socket && newToken) {
			this.socket.auth = { token: newToken }
			this.socket?.connect()
		} else {
			// If we can't refresh the token, switch to offline mode
			this.networkStore.setOfflineMode(true)
		}
	}

	handleInitRoom() {
		if (this.networkStore.isOfflineMode) return

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
		if (this.networkStore.isOfflineMode) return

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
		if (this.networkStore.isOfflineMode) return

		const reconciledElements = this.collab._reconcileElements(elements)
		this.collab.handleRemoteSceneUpdate(reconciledElements)
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
		if (this.networkStore.isOfflineMode) return

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
		if (this.networkStore.isOfflineMode) return

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
		if (this.networkStore.isOfflineMode) return

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
		if (this.networkStore.isOfflineMode) {
			// In offline mode, just add files locally
			Object.values(files).forEach((file) => {
				this.collab.addFile(file)
			})
			return
		}

		Object.values(files).forEach((file) => {
			this.collab.addFile(file)
			this.socket?.emit('image-add', this.roomId, file.id, file)
		})
	}

}
