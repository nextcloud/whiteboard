/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { generateUrl } from '@nextcloud/router'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'
import type { CollaborationSocket } from '../types/collaboration'
import type { WorkerInboundMessage } from '../types/protocol'
import type { CollaborationConnectionStatus } from '../stores/useCollaborationStore'

enum SyncMessageType {
	SceneInit = 'SCENE_INIT',
	ImageAdd = 'IMAGE_ADD',
	ServerBroadcast = 'server-broadcast',
}

export type SyncAuthorityState = {
	isDedicatedSyncer: boolean
	isLocalLeader: boolean
	isReadOnly: boolean
}

export type SyncableExcalidrawAPI = {
	getSceneElementsIncludingDeleted: () => readonly ExcalidrawElement[]
	getFiles: () => BinaryFiles
	getAppState: () => {
		selectedElementIds: Record<string, boolean>
		scrollX: number
		scrollY: number
		zoom: { value: number }
	}
}

export type WorkerLike = {
	postMessage: (message: WorkerInboundMessage) => void
}

const hashFileContent = (content: string): string => {
	if (!content) return ''
	const len = content.length
	const start = content.substring(0, 20)
	const end = content.substring(Math.max(0, len - 20))
	return `${len}:${start}:${end}`
}

export const canRunAuthoritativeSync = ({ isDedicatedSyncer, isLocalLeader, isReadOnly }: SyncAuthorityState) => (
	isDedicatedSyncer && isLocalLeader && !isReadOnly
)

export const canRunOnlineAuthoritativeSync = (
	authority: SyncAuthorityState,
	collabStatus: CollaborationConnectionStatus,
) => (
	canRunAuthoritativeSync(authority) && collabStatus === 'online'
)

export const emitWebSocketSceneAndFilesSync = ({
	fileId,
	excalidrawAPI,
	socket,
	prevSyncedFiles,
}: {
	fileId: number
	excalidrawAPI: SyncableExcalidrawAPI
	socket: Pick<CollaborationSocket, 'emit'>
	prevSyncedFiles: Record<string, string>
}) => {
	const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
	const files = excalidrawAPI.getFiles()

	const sceneData = { type: SyncMessageType.SceneInit, payload: { elements } }
	const sceneBuffer = new TextEncoder().encode(JSON.stringify(sceneData))
	socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, sceneBuffer, [])

	const nextFileHashes: Record<string, string> = {}
	Object.values(files || {}).forEach((file) => {
		if (!file?.id || !file.dataURL) {
			return
		}

		const currentHash = hashFileContent(file.dataURL)
		nextFileHashes[file.id] = currentHash

		if (prevSyncedFiles[file.id] === currentHash) {
			return
		}

		const fileData = { type: SyncMessageType.ImageAdd, payload: { file } }
		const fileBuffer = new TextEncoder().encode(JSON.stringify(fileData))
		socket.emit(SyncMessageType.ServerBroadcast, `${fileId}`, fileBuffer, [])
	})

	return {
		elementsCount: elements.length,
		nextFileHashes,
	}
}

export const runWebSocketSyncIfAllowed = ({
	authority,
	collabStatus,
	fileId,
	excalidrawAPI,
	socket,
	prevSyncedFiles,
}: {
	authority: SyncAuthorityState
	collabStatus: CollaborationConnectionStatus
	fileId: number
	excalidrawAPI: SyncableExcalidrawAPI | null
	socket: Pick<CollaborationSocket, 'emit'> | null
	prevSyncedFiles: Record<string, string>
}) => {
	if (!fileId || !excalidrawAPI || !socket || !canRunOnlineAuthoritativeSync(authority, collabStatus)) {
		return {
			sent: false,
			elementsCount: 0,
			nextFileHashes: prevSyncedFiles,
		}
	}

	const result = emitWebSocketSceneAndFilesSync({
		fileId,
		excalidrawAPI,
		socket,
		prevSyncedFiles,
	})

	return {
		sent: true,
		...result,
	}
}

export const postSyncToServerWorker = async ({
	forceSync = false,
	fileId,
	excalidrawAPI,
	getJWT,
	worker,
	currentFileId,
}: {
	forceSync?: boolean
	fileId: number
	excalidrawAPI: SyncableExcalidrawAPI
	getJWT: () => Promise<string | null>
	worker: WorkerLike
	currentFileId: number
}) => {
	const jwt = await getJWT()
	if (!jwt) {
		throw new Error('JWT token missing for server API sync.')
	}

	if (currentFileId !== fileId) {
		throw new Error(`FileId changed during ${forceSync ? 'forced ' : ''}server sync preparation.`)
	}

	const message: WorkerInboundMessage = {
		type: 'SYNC_TO_SERVER',
		fileId,
		url: generateUrl(`apps/whiteboard/${fileId}`),
		jwt,
		elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
		files: excalidrawAPI.getFiles(),
	}

	worker.postMessage(message)
}

export const runServerApiSyncIfAllowed = async ({
	forceSync = false,
	authority,
	collabStatus,
	fileId,
	excalidrawAPI,
	getJWT,
	worker,
	isWorkerReady,
	currentFileId,
}: {
	forceSync?: boolean
	authority: SyncAuthorityState
	collabStatus: CollaborationConnectionStatus
	fileId: number
	excalidrawAPI: SyncableExcalidrawAPI | null
	getJWT: () => Promise<string | null>
	worker: WorkerLike | null
	isWorkerReady: boolean
	currentFileId: number
}) => {
	if (!isWorkerReady || !worker || !fileId || !excalidrawAPI) {
		return false
	}

	if (!canRunAuthoritativeSync(authority) || (!forceSync && collabStatus !== 'online')) {
		return false
	}

	await postSyncToServerWorker({
		forceSync,
		fileId,
		excalidrawAPI,
		getJWT,
		worker,
		currentFileId,
	})

	return true
}
