/* eslint-disable no-console */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { io } from 'socket.io-client'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'

export class Collab {

	excalidrawAPI : ExcalidrawImperativeAPI
	portal: Portal
	lastBroadcastedOrReceivedSceneVersion: number = -1

	constructor(excalidrawAPI : ExcalidrawImperativeAPI) {
		this.excalidrawAPI = excalidrawAPI
		this.portal = new Portal('1', '1', this)
	}

	startCollab() {
		if (this.portal.socket) return
		this.portal.open(io('nextcloud.local:3002/'))
		this.excalidrawAPI.onChange(this.onChange)
	}

	/**
	 * Hashes elements' versionNonce (using djb2 algo). Order of elements matters.
	 * @param elements all Elements
	 */
	private hashElementsVersion = (
		elements: readonly ExcalidrawElement[],
	): number => {
		return elements.reduce((acc, el) => acc + el.version, 0)
	}

	getLastBroadcastedOrReceivedSceneVersion() {
		return this.lastBroadcastedOrReceivedSceneVersion
	}

	private onChange = (elements: readonly ExcalidrawElement[], state: AppState) => {

		if (this.hashElementsVersion(elements)
			> this.getLastBroadcastedOrReceivedSceneVersion()
		) {
			this.lastBroadcastedOrReceivedSceneVersion = this.hashElementsVersion(elements)
			throttle(() => this.portal.broadcastScene('SCENE_INIT', elements))()
		}
	}

	public getSceneElementsIncludingDeleted = () => {
		return this.excalidrawAPI.getSceneElementsIncludingDeleted()
	}

	reconcileElements(localElements: readonly ExcalidrawElement[], remoteElements: ExcalidrawElement[], appState: Readonly<AppState>) {
		const added = new Set<string>()
		const localElementsMap = this.arrayToMap(localElements)
		const reconciledElements: ExcalidrawElement[] = []

		for (const remoteElement of remoteElements) {
			if (!added.has(remoteElement.id)) {
				const localElement = localElementsMap.get(remoteElement.id)
				const discardRemoteElement = this.shouldDiscardRemoteElement(
					appState,
					localElement,
					remoteElement,
				)

				if (localElement && discardRemoteElement) {
					reconciledElements.push(localElement)
					added.add(localElement.id)
				} else {
					reconciledElements.push(remoteElement)
					added.add(remoteElement.id)
			  }
			}
		}
		for (const localElement of localElements) {
			if (!added.has(localElement.id)) {
				reconciledElements.push(localElement)
				added.add(localElement.id)
			}
		}

		return reconciledElements
	}

	/**
	 * Transforms array of objects containing `id` attribute,
	 * or array of ids (strings), into a Map, keyd by `id`.
	 * @param items
	 */
	arrayToMap = <T extends { id: string } | string>(
		items: readonly T[] | Map<string, T>,
	) => {
		if (items instanceof Map) {
			return items
		}
		return items.reduce((acc: Map<string, T>, element) => {
			acc.set(typeof element === 'string' ? element : element.id, element)
			return acc
		}, new Map())
	}

	shouldDiscardRemoteElement(localAppState: Readonly<AppState>, localElement: ExcalidrawElement | undefined, remoteElement: ExcalidrawElement) {
		if (
			localElement
			// local element is being edited
			&& (localElement.id === localAppState.editingElement?.id
			  || localElement.id === localAppState.resizingElement?.id
			  || localElement.id === localAppState.draggingElement?.id // TODO: Is this still valid? As draggingElement is selection element, which is never part of the elements array
			  // local element is newer
			  || localElement.version > remoteElement.version
			  // resolve conflicting edits deterministically by taking the one with
			  // the lowest versionNonce
			  || (localElement.version === remoteElement.version
				&& localElement.versionNonce < remoteElement.versionNonce))
		  ) {
			return true
		  }
		  return false
	}

	public _reconcileElements = (remoteElements: readonly ExcalidrawElement[]) => {
		const restoredRemoteElements = restoreElements(remoteElements, null)
		const localElements = this.getSceneElementsIncludingDeleted()
		const appState = this.excalidrawAPI.getAppState()

		const reconciledElements = this.reconcileElements(localElements, restoredRemoteElements, appState)

		return reconciledElements
	}

	handleRemoteSceneUpdate(elements: ExcalidrawElement[]) {
		this.excalidrawAPI.updateScene({
			elements,
		},
		)
	}

}
