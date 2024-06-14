import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { Socket } from 'socket.io-client'
import type { Collab } from './collab'
import type { Gesture } from '@excalidraw/excalidraw/types/types'
import axios from '@nextcloud/axios'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	MouseLocation = 'MOUSE_LOCATION',
}

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

		const eventsNeedingTokenRefresh = ['connect_error', 'token-expired', 'invalid-token']
		eventsNeedingTokenRefresh.forEach((event) =>
			this.socket?.on(event, async (err) => {
				if (['Authentication error', undefined].includes(err?.message)) {
					await this.handleTokenRefresh()
				}
			})
		)

		this.socket.on('init-room', () => this.handleInitRoom())
		this.socket.on('room-user-change', (users: any) => this.collab.updateCollaborators(users))
		this.socket.on('client-broadcast', (data) => this.handleClientBroadcast(data))
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
			const reconciledElements = this.collab._reconcileElements(remoteElements)
			this.collab.handleRemoteSceneUpdate(reconciledElements)
			this.collab.scrollToContent()
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
			const response = await axios.get('/index.php/apps/whiteboard/token', { withCredentials: true })
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

	async _broadcastSocketData(data: any, volatile: boolean = false, roomId?: string) {
		const json = JSON.stringify(data)
		const encryptedBuffer = new TextEncoder().encode(json)
		this.socket?.emit(volatile ? 'server-volatile-broadcast' : 'server-broadcast', roomId ?? this.roomId, encryptedBuffer, [])
	}

	async broadcastScene(updateType: string, elements: readonly ExcalidrawElement[]) {
		await this._broadcastSocketData({ type: updateType, payload: { elements } })
	}

	async broadcastMouseLocation(payload: {
		pointer: { x: number; y: number; tool: 'pointer' | 'laser' };
		button: 'down' | 'up';
		pointersMap: Gesture['pointers'];
	}) {
		const data = {
			type: BroadcastType.MouseLocation,
			payload: {
				socketId: this.socket?.id,
				pointer: payload.pointer,
				button: payload.button || 'up',
				selectedElementIds: this.collab.excalidrawAPI.getAppState().selectedElementIds,
				username: this.socket?.id
			}
		}
		await this._broadcastSocketData(data, true)
	}
}
