import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { io } from 'socket.io-client'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'
import { hashElementsVersion, reconcileElements } from './util'

export class Collab {

	excalidrawAPI : ExcalidrawImperativeAPI
	portal: Portal
	lastBroadcastedOrReceivedSceneVersion: number = -1

	constructor(excalidrawAPI : ExcalidrawImperativeAPI) {
		this.excalidrawAPI = excalidrawAPI
		const url = window.location.href
		const fileIdMatch = url.match(/\/files\/(\d+)\?/)

		if (fileIdMatch) {
			alert(`${fileIdMatch[1]}`)
			this.portal = new Portal(fileIdMatch[1], '1', this)
		} else {
			throw new Error('No FileId found in URL')
		}
	}

	startCollab() {
		if (this.portal.socket) return
		this.portal.open(io('nextcloud.local:3002/'))
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

}
