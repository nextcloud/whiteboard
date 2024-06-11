import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, Collaborator, ExcalidrawImperativeAPI, Gesture } from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { io } from 'socket.io-client'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'
import { hashElementsVersion, reconcileElements } from './util'
import { loadState } from '@nextcloud/initial-state'

export class Collab {

	excalidrawAPI: ExcalidrawImperativeAPI
	portal: Portal
	lastBroadcastedOrReceivedSceneVersion: number = -1
	private collaborators = new Map<string, Collaborator>()

	constructor(excalidrawAPI: ExcalidrawImperativeAPI, fileId: number) {
		this.excalidrawAPI = excalidrawAPI
		this.portal = new Portal(String(fileId), '1', this)
	}

	startCollab() {
		if (this.portal.socket) return

		const collabBackendUrl = loadState('whiteboard', 'collabBackendUrl', 'nextcloud.local:3002')
		this.portal.open(io(collabBackendUrl))
		this.excalidrawAPI.onChange(this.onChange)
	}

	getSceneElementsIncludingDeleted = () => {
		return this.excalidrawAPI.getSceneElementsIncludingDeleted()
	}

	_reconcileElements = (remoteElements: readonly ExcalidrawElement[]) => {
		const restoredRemoteElements = restoreElements(remoteElements, null)
		const localElements = this.getSceneElementsIncludingDeleted()
		const appState = this.excalidrawAPI.getAppState()

		const reconciledElements = reconcileElements(localElements, restoredRemoteElements, appState)

		return reconciledElements
	}

	handleRemoteSceneUpdate = (elements: ExcalidrawElement[]) => {
		this.excalidrawAPI.updateScene({
			elements,
		},
		)
	}

	private getLastBroadcastedOrReceivedSceneVersion = () => {
		return this.lastBroadcastedOrReceivedSceneVersion
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private onChange = (elements: readonly ExcalidrawElement[], _state: AppState) => {
		if (hashElementsVersion(elements)
			> this.getLastBroadcastedOrReceivedSceneVersion()
		) {
			this.lastBroadcastedOrReceivedSceneVersion = hashElementsVersion(elements)
			throttle(() => this.portal.broadcastScene('SCENE_INIT', elements))()
		}
	}

	onPointerUpdate = (payload: {
		pointersMap: Gesture['pointers'],
		pointer: { x: number; y: number; tool: 'laser' | 'pointer' },
		button: 'down' | 'up'
	}) => {
		payload.pointersMap.size < 2 && this.portal.socket && this.portal.broadcastMouseLocation(payload)
	}

	setCollaborators(socketIds: string[]) {
		const collaborators = new Map()
		for (const socketId of socketIds) {
			collaborators.set(socketId, Object.assign({}, this.collaborators.get(socketId), {
				isCurrentUser: socketId === this.portal.socket?.id,
			}))
		}

		this.collaborators = collaborators
		this.excalidrawAPI.updateScene({ collaborators })
	}

	updateCollaborator = (socketId: string, updates: Partial<Collaborator>) => {
		const collaborators = new Map(this.collaborators)
		const user = Object.assign({}, collaborators.get(socketId), updates, { isCurrentUser: socketId === this.portal.socket?.id })
		collaborators.set(socketId, user)
		this.collaborators = collaborators

		this.excalidrawAPI.updateScene({
			collaborators,
		})
	}

}
