/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { Socket } from 'socket.io-client'
import type { Collab } from './collab'

export class Portal {

	socket: Socket | null = null
	roomId: string
	roomKey: string
	broadcastedElementVersions: Map<string, number> = new Map()
	collab: Collab

	constructor(roomId: string, roomKey: string, collab: Collab) {
		this.roomId = roomId
		this.roomKey = roomKey
		this.collab = collab
	}

	open(socket: Socket) {
		this.socket = socket
		this.socket.on('init-room', () => {
			alert('room initialized')
			console.log('room initialized')
			if (this.socket) {
				alert(`joined room ${this.roomId}`)
				console.log(`joined room ${this.roomId}`)
				this.socket.emit('join-room', this.roomId)
			}
		})
		this.socket.on('new-user', async (_socketId: string) => {
			alert(`NEW USER ${_socketId}`)
			console.log(`NEW USER ${_socketId}`)
			this.broadcastScene('SCENE_INIT', this.collab.getSceneElementsIncludingDeleted())
		})

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.socket.on('room-user-change', (clients: any) => {
			alert(`ROOM USER CHANGE ${clients}`)
			console.log(`ROOM USER CHANGE ${clients}`)
		})

		this.socket.on('client-broadcast', (data, iv:Uint8Array) => {
			console.log(iv, data)

			switch (data.type) {
			case 'SCENE_INIT': {
				const remoteElements = data.payload.elements
				const reconciledElements = this.collab._reconcileElements(remoteElements)
				break
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
		roomId?: string,
	  ) {
		if (this.isOpen()) {
		  const json = JSON.stringify(data)
		  const encoded = new TextEncoder().encode(json)
		  const encryptedBuffer = encoded

		  this.socket?.emit(
				volatile ? 'server-volatile-broadcast' : 'server-broadcast',
				roomId ?? this.roomId,
				encryptedBuffer,
				[],
		  )
		}
	  }

	async broadcastScene(
		updateType: string,
		elements: readonly ExcalidrawElement[]) {

		for (const element of elements) {
			this.broadcastedElementVersions.set(
				element.id,
				element.version,
			)
		}

		const data = {
			type: updateType,
			payload: {
				elements,
			},
		}
		await this._broadcastSocketData(data)
		alert('BROADCASTED')
	}

}
