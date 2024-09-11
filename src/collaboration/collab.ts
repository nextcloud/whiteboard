/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { AppState, Collaborator, ExcalidrawImperativeAPI, Gesture } from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'
import { hashElementsVersion, reconcileElements } from './util'

export class Collab {

	excalidrawAPI: ExcalidrawImperativeAPI
	fileId: number
	portal: Portal
	publicSharingToken: string | null
	lastBroadcastedOrReceivedSceneVersion: number = -1
	private collaborators = new Map<string, Collaborator>()

	constructor(excalidrawAPI: ExcalidrawImperativeAPI, fileId: number, publicSharingToken: string | null) {
		this.excalidrawAPI = excalidrawAPI
		this.fileId = fileId
		this.publicSharingToken = publicSharingToken

		this.portal = new Portal(`${fileId}`, this, publicSharingToken)
	}

	async startCollab() {
		if (this.portal.socket) return

		this.portal.connectSocket()

		this.excalidrawAPI.onChange(this.onChange)
	}

	getSceneElementsIncludingDeleted = () => {
		return this.excalidrawAPI.getSceneElementsIncludingDeleted()
	}

	_reconcileElements = (remoteElements: readonly ExcalidrawElement[]) => {
		const restoredRemoteElements = restoreElements(remoteElements, null)
		const localElements = this.getSceneElementsIncludingDeleted()
		const appState = this.excalidrawAPI.getAppState()

		return reconcileElements(localElements, restoredRemoteElements, appState)
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

	updateCollaborators = (users: {
		user: {
			id: string,
			name: string
		},
		socketId: string,
		pointer: { x: number, y: number, tool: 'pointer' | 'laser' },
		button: 'down' | 'up',
		selectedElementIds: AppState['selectedElementIds']
	}[]) => {
		const collaborators = new Map<string, Collaborator>()

		users.forEach((payload) => {
			collaborators.set(payload.user.id, {
				username: payload.user.name,
				...payload,
			})
		})

		this.excalidrawAPI.updateScene({ collaborators })

		this.collaborators = collaborators
	}

	updateCursor = (payload: {
		socketId: string,
		pointer: { x: number, y: number, tool: 'pointer' | 'laser' },
		button: 'down' | 'up',
		selectedElementIds: AppState['selectedElementIds'],
		user: {
			id: string,
			name: string
		}
	}) => {
		this.excalidrawAPI.updateScene({
			collaborators: this.collaborators.set(payload.user.id, {
				...this.collaborators.get(payload.user.id),
				...payload,
				username: payload.user.name,
			}),
		})
	}

	scrollToContent = () => {
		const elements = this.excalidrawAPI.getSceneElements()

		this.excalidrawAPI.scrollToContent(elements, {
			fitToContent: true,
			animate: true,
			duration: 500,
		})
	}

	makeBoardReadOnly = () => {
		this.excalidrawAPI.updateScene({
			appState: {
				viewModeEnabled: true,
			},
		})
	}

}
