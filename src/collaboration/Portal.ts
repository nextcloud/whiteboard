/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { Socket } from 'socket.io-client'
import type { Collab } from './collab'
import type { Gesture } from '@excalidraw/excalidraw/types/types'

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

		this.socket.on('init-room', () => {
			console.log('room initialized')
			if (this.socket) {
				console.log(`joined room ${this.roomId}`)
				this.socket.emit('join-room', this.roomId)

				this.socket.on('joined-data', (data) => {
					const remoteElements = JSON.parse(new TextDecoder().decode(data))

					console.log(`JOINED DATA ${new TextDecoder().decode(data)}`)

					const reconciledElements = this.collab._reconcileElements(remoteElements)

					this.collab.handleRemoteSceneUpdate(reconciledElements)

					const elements = this.collab.excalidrawAPI.getSceneElements()

					this.collab.excalidrawAPI.scrollToContent(elements, {
						fitToContent: true,
						animate: true,
						duration: 500
					})
				})
			}
		})

		this.socket.on('new-user', async (_socketId: string) => {
			console.log(`NEW USER ${_socketId}`)

			this.broadcastScene('SCENE_INIT', this.collab.getSceneElementsIncludingDeleted())
		})

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.socket.on('room-user-change', (clients: any) => {
			console.log(`ROOM USER CHANGE ${clients}`)
		})

		this.socket.on('client-broadcast', (data, iv: Uint8Array) => {
			const decoded = JSON.parse(new TextDecoder().decode(data))
			console.log(decoded)
			console.log(data)

			switch (decoded.type) {
				case 'SCENE_INIT': {
					const remoteElements = decoded.payload.elements
					const reconciledElements = this.collab._reconcileElements(remoteElements)
					this.collab.handleRemoteSceneUpdate(reconciledElements)
					break
				}
				case 'MOUSE_LOCATION': {
					this.collab.updateCollaborator(decoded.payload.socketId, decoded.payload)
				}
			}
		})

		return this.socket
	}

	isOpen() {
		return true
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
