/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'
import type { CollaborationSocket } from '../types/collaboration'

enum BroadcastType {
	SceneInit = 'SCENE_INIT',
	ImageAdd = 'IMAGE_ADD',
}

type BootstrapCapableSocket = Pick<CollaborationSocket, 'emit'>

type BootstrapCapableExcalidrawAPI = {
	getSceneElementsIncludingDeleted?: () => readonly ExcalidrawElement[]
	getFiles: () => BinaryFiles
}

export const canRespondToBootstrapTraffic = ({
	isDedicatedSyncer,
	isLocalLeader,
	fileId,
	excalidrawAPI,
	socket,
}: {
	isDedicatedSyncer: boolean
	isLocalLeader: boolean
	fileId: number
	excalidrawAPI: BootstrapCapableExcalidrawAPI | null
	socket: (BootstrapCapableSocket & { connected?: boolean }) | null
}) => (
	Boolean(fileId)
	&& Boolean(excalidrawAPI)
	&& Boolean(socket?.connected)
	&& isDedicatedSyncer
	&& isLocalLeader
)

export const sendSceneBootstrapToRoom = ({
	socket,
	fileId,
	excalidrawAPI,
}: {
	socket: BootstrapCapableSocket
	fileId: number
	excalidrawAPI: Required<Pick<BootstrapCapableExcalidrawAPI, 'getSceneElementsIncludingDeleted'>>
}) => {
	const sceneData = {
		type: BroadcastType.SceneInit,
		payload: {
			elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
		},
	}

	socket.emit('server-broadcast', `${fileId}`, new TextEncoder().encode(JSON.stringify(sceneData)), [])
}

export const sendImageFilesToRoom = ({
	socket,
	fileId,
	files,
	requestedFileId,
}: {
	socket: BootstrapCapableSocket
	fileId: number
	files: BinaryFiles
	requestedFileId?: string
}) => {
	Object.values(files || {}).forEach((file) => {
		if (!file?.dataURL) {
			return
		}

		if (requestedFileId && file.id !== requestedFileId) {
			return
		}

		const fileData = { type: BroadcastType.ImageAdd, payload: { file } }
		socket.emit('server-broadcast', `${fileId}`, new TextEncoder().encode(JSON.stringify(fileData)), [])
	})
}

export const sendSceneBootstrapIfAllowed = ({
	isDedicatedSyncer,
	isLocalLeader,
	fileId,
	excalidrawAPI,
	socket,
}: {
	isDedicatedSyncer: boolean
	isLocalLeader: boolean
	fileId: number
	excalidrawAPI: BootstrapCapableExcalidrawAPI | null
	socket: (BootstrapCapableSocket & { connected?: boolean }) | null
}) => {
	if (
		!canRespondToBootstrapTraffic({
			isDedicatedSyncer,
			isLocalLeader,
			fileId,
			excalidrawAPI,
			socket,
		})
		|| !excalidrawAPI?.getSceneElementsIncludingDeleted
	) {
		return false
	}

	sendSceneBootstrapToRoom({
		socket: socket!,
		fileId,
		excalidrawAPI: {
			getSceneElementsIncludingDeleted: excalidrawAPI.getSceneElementsIncludingDeleted,
		},
	})
	sendImageFilesToRoom({
		socket: socket!,
		fileId,
		files: excalidrawAPI.getFiles(),
	})
	return true
}

export const sendRequestedImageIfAllowed = ({
	isDedicatedSyncer,
	isLocalLeader,
	fileId,
	excalidrawAPI,
	socket,
	requestedFileId,
}: {
	isDedicatedSyncer: boolean
	isLocalLeader: boolean
	fileId: number
	excalidrawAPI: BootstrapCapableExcalidrawAPI | null
	socket: (BootstrapCapableSocket & { connected?: boolean }) | null
	requestedFileId: string
}) => {
	if (
		!requestedFileId
		|| !canRespondToBootstrapTraffic({
			isDedicatedSyncer,
			isLocalLeader,
			fileId,
			excalidrawAPI,
			socket,
		})
	) {
		return false
	}

	const file = excalidrawAPI!.getFiles()[requestedFileId]
	if (!file?.dataURL) {
		return false
	}

	sendImageFilesToRoom({
		socket: socket!,
		fileId,
		files: excalidrawAPI!.getFiles(),
		requestedFileId,
	})
	return true
}
