/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { Socket } from 'socket.io-client'
import type { Collab } from './collab'
import type { Gesture } from '@excalidraw/excalidraw/types/types'
import axios from '@nextcloud/axios'

export class Portal {

	socket: Socket | null = null
	roomId: string
	roomKey: string
	collab: Collab

	constructor(roomId: string, roomKey: string, collab: Collab) {
		this.roomId = roomId
		this.roomKey = roomKey
		this.collab = collab
	}

	open(socket: Socket) {
		this.socket = socket

		this.socket.on('connect_error', async (err) => {
			if (err.message === 'Authentication error') {
				const newToken = await this.refreshJWT()

				if (newToken) {
					socket.auth.token = newToken
					socket.connect()
				}
			}
		})

		this.socket.on('token-expired', async () => {
			const newToken = await this.refreshJWT()

			if (newToken) {
				socket.auth.token = newToken
				socket.connect()
			}
		})

		this.socket.on('invalid-token', async () => {
			const newToken = await this.refreshJWT()

			if (newToken) {
				socket.auth.token = newToken
				socket.connect()
			}
		})

		this.socket.on('init-room', () => {
			if (this.socket) {
				this.socket.emit('join-room', this.roomId)

				this.socket.on('joined-data', (data) => {
					const remoteElements = JSON.parse(new TextDecoder().decode(data))

					const reconciledElements = this.collab._reconcileElements(remoteElements)

					this.collab.handleRemoteSceneUpdate(reconciledElements)

					this.collab.scrollToContent()
				})
			}
		})

		this.socket.on('room-user-change', (users: any) => {
			this.collab.updateCollaborators(users)
		})

		this.socket.on('client-broadcast', (data) => {
			const decoded = JSON.parse(new TextDecoder().decode(data))

			switch (decoded.type) {
				case 'SCENE_INIT': {
					const remoteElements = decoded.payload.elements
					const reconciledElements = this.collab._reconcileElements(remoteElements)
					this.collab.handleRemoteSceneUpdate(reconciledElements)
					break
				}

				case 'MOUSE_LOCATION': {
					const collaborator = decoded.payload

					this.collab.updateCursor(collaborator)
				}
			}
		})
	}

	async refreshJWT(): Promise<string | null> {
		try {
			const response = await axios.get('/index.php/apps/whiteboard/token', {
				withCredentials: true
			})
			const token = response.data.token

			if (!token) throw new Error('No token received')

			localStorage.setItem('jwt', token)

			return token
		} catch (error) {
			console.error('Error refreshing JWT:', error)

			window.location.href = '/index.php/apps/files/files'

			return null
		}
	}

	async _broadcastSocketData(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		data: any,
		volatile: boolean = false,
		roomId?: string
	) {
		const json = JSON.stringify(data)

		const encryptedBuffer = new TextEncoder().encode(json)

		this.socket?.emit(
			volatile ? 'server-volatile-broadcast' : 'server-broadcast',
			roomId ?? this.roomId,
			encryptedBuffer,
			[]
		)
	}

	async broadcastScene(
		updateType: string,
		elements: readonly ExcalidrawElement[]) {
		const data = {
			type: updateType,
			payload: {
				elements
			}
		}
		await this._broadcastSocketData(data)
	}

	async broadcastMouseLocation(payload: {
		pointer: { x: number, y: number, tool: 'pointer' | 'laser' };
		button: 'down' | 'up';
		pointersMap: Gesture['pointers'];
	}) {
		const data = {
			type: 'MOUSE_LOCATION',
			payload: {
				socketId: this.socket?.id,
				pointer: payload.pointer,
				button: payload.button || 'up',
				selectedElementIds: this.collab.excalidrawAPI.getAppState().selectedElementIds,
				username: this.socket?.id
			}
		}

		return this._broadcastSocketData(
			data,
			true // volatile
		)
	}

}
