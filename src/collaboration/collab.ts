/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { io } from 'socket.io-client'
import { restoreElements } from '@excalidraw/excalidraw'

export class Collab {

	excalidrawAPI : ExcalidrawImperativeAPI
	portal: Portal

	constructor(excalidrawAPI : ExcalidrawImperativeAPI) {
		this.excalidrawAPI = excalidrawAPI
		this.portal = new Portal('1', '1', this)
	}

	startCollab() {
		if (this.portal.socket) return
		this.portal.open(io('nextcloud.local:3002/'))
		alert('starting collab')
		this.excalidrawAPI.onChange(this.onChange)
	}

	private onChange = (elements: readonly ExcalidrawElement[], state: AppState) => {
		this.portal.broadcastScene('SCENE_INIT', elements)
		console.log('updated')
	}

	public getSceneElementsIncludingDeleted = () => {
		return this.excalidrawAPI.getSceneElementsIncludingDeleted()
	}

	public _reconcileElements = (remoteElements: readonly ExcalidrawElement[]) => {
		const restoredRemoteElements = restoreElements(remoteElements, null)

		// TODO excalidraw.com has a reconcilation algo in place here
		// const localElements = this.getSceneElementsIncludingDeleted()
		// const appState = this.excalidrawAPI.getAppState()
		// const reconciledElements = reconcileElements(localElements,restoredRemoteElements, appState)

		return restoredRemoteElements
	}

	handleRemoteSceneUpdate(elements: ExcalidrawElement[]) {
		this.excalidrawAPI.updateScene({
			elements,
		},
		)
	}

}
