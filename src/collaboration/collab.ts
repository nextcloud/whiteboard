/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type {
	AppState,
	BinaryFileData,
	BinaryFiles,
	Collaborator,
	ExcalidrawImperativeAPI,
	Gesture,
} from '@excalidraw/excalidraw/types/types'
import { Portal } from './Portal'
import { restoreElements } from '@excalidraw/excalidraw'
import { throttle } from 'lodash'
import { hashElementsVersion, reconcileElements } from './util'
import { registerFilesHandler } from '../files/files.ts'

export class Collab {

	excalidrawAPI: ExcalidrawImperativeAPI
	fileId: number
	portal: Portal
	publicSharingToken: string | null
	setViewModeEnabled: React.Dispatch<React.SetStateAction<boolean>>
	lastBroadcastedOrReceivedSceneVersion: number = -1
	private collaborators = new Map<string, Collaborator>()
	private files = new Map<string, BinaryFileData>()
	private followedUserId: string | null = null
	private lastBroadcastedViewport = {
		scrollX: 0,
		scrollY: 0,
		zoom: 1,
	}

	constructor(
		excalidrawAPI: ExcalidrawImperativeAPI,
		fileId: number,
		publicSharingToken: string | null,
		setViewModeEnabled: React.Dispatch<React.SetStateAction<boolean>>,
		collabBackendUrl: string,
	) {
		this.excalidrawAPI = excalidrawAPI
		this.fileId = fileId
		this.publicSharingToken = publicSharingToken
		this.setViewModeEnabled = setViewModeEnabled

		this.portal = new Portal(`${fileId}`, this, publicSharingToken, collabBackendUrl)
		registerFilesHandler(this.excalidrawAPI, this)
	}

	async startCollab() {
		if (this.portal.socket) return

		this.portal.connectSocket()

		this.excalidrawAPI.onChange(this.onChange)

		window.collab = this
	}

	getSceneElementsIncludingDeleted = () => {
		return this.excalidrawAPI.getSceneElementsIncludingDeleted()
	}

	_reconcileElements = (remoteElements: readonly ExcalidrawElement[]) => {
		const restoredRemoteElements = restoreElements(remoteElements, null)
		const localElements = this.getSceneElementsIncludingDeleted()
		const appState = this.excalidrawAPI.getAppState()

		return reconcileElements(
			localElements,
			restoredRemoteElements,
			appState,
		)
	}

	handleRemoteSceneUpdate = (elements: ExcalidrawElement[]) => {
		this.excalidrawAPI.updateScene({
			elements,
		})
	}

	private getLastBroadcastedOrReceivedSceneVersion = () => {
		return this.lastBroadcastedOrReceivedSceneVersion
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private onChange = (
		elements: readonly ExcalidrawElement[],
		state: AppState,
		files: BinaryFiles,
	) => {
		if (
			hashElementsVersion(elements)
			> this.getLastBroadcastedOrReceivedSceneVersion()
		) {
			this.lastBroadcastedOrReceivedSceneVersion
				= hashElementsVersion(elements)
			throttle(() => {
				this.portal.broadcastScene('SCENE_INIT', elements)

				const syncedFiles = Array.from(this.files.keys())
				const newFiles = Object.keys(files)
					.filter((id) => !syncedFiles.includes(id))
					.reduce((acc, id) => {
						acc[id] = files[id]
						return acc
					}, {} as BinaryFiles)
				if (Object.keys(newFiles).length > 0) {
					this.portal.sendImageFiles(newFiles)
				}
			})()
		}

		this.broadcastViewportIfChanged(state)
	}

	private broadcastViewportIfChanged(state: AppState) {
		const { scrollX, scrollY, zoom } = state
		if (
			scrollX !== this.lastBroadcastedViewport.scrollX
			|| scrollY !== this.lastBroadcastedViewport.scrollY
			|| zoom.value !== this.lastBroadcastedViewport.zoom
		) {
			this.lastBroadcastedViewport = {
				scrollX,
				scrollY,
				zoom: zoom.value,
			}
			this.portal.broadcastViewport(scrollX, scrollY, zoom.value)
		}
	}

	onPointerUpdate = (payload: {
		pointersMap: Gesture['pointers']
		pointer: { x: number; y: number; tool: 'laser' | 'pointer' }
		button: 'down' | 'up'
	}) => {
		payload.pointersMap.size < 2
			&& this.portal.socket
			&& this.portal.broadcastMouseLocation(payload)
	}

	updateCollaborators = (
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
	) => {
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
		socketId: string
		pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
		button: 'down' | 'up'
		selectedElementIds: AppState['selectedElementIds']
		user: {
			id: string
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
		this.setViewModeEnabled(true)
	}

	addFile = (file: BinaryFileData) => {
		this.files.set(file.id, file)
		this.excalidrawAPI.addFiles([file])
	}

	followUser(userId: string) {
		this.followedUserId = userId
		const collabInfo = this.collaborators.get(userId)
		if (collabInfo?.viewport) {
			this.applyViewport(collabInfo.viewport)
		}
	}

	unfollowUser() {
		this.followedUserId = null
	}

	updateCollaboratorViewport = (
		userId: string,
		scrollX: number,
		scrollY: number,
		zoom: number,
	) => {
		const collaborator = this.collaborators.get(userId)
		if (!collaborator) return

		const updated = {
			...collaborator,
			viewport: { scrollX, scrollY, zoom },
		}
		this.collaborators.set(userId, updated)

		if (this.followedUserId === userId) {
			this.applyViewport({ scrollX, scrollY, zoom })
		}

		this.excalidrawAPI.updateScene({ collaborators: this.collaborators })
	}

	private applyViewport({
		scrollX,
		scrollY,
		zoom,
	}: {
		scrollX: number
		scrollY: number
		zoom: number
	}) {
		const appState = this.excalidrawAPI.getAppState()
		this.excalidrawAPI.updateScene({
			appState: {
				...appState,
				scrollX,
				scrollY,
				zoom: { value: zoom },
			},
		})
	}

}
