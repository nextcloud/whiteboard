/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { WorkerInboundMessage, WorkerOutboundMessage } from '../types/protocol'
import {
	areSnapshotsEquivalent,
	extractSnapshotFromPersistedBoard,
	mergeLocalPendingWithServerSnapshot,
	normalizePersistedBoardDocument,
	normalizePersistedBoardMeta,
} from '../utils/persistedBoardData'
import { computeElementVersionHash } from '../utils/syncSceneData'

type SyncToLocalMessage = Extract<WorkerInboundMessage, { type: 'SYNC_TO_LOCAL' }>
type SyncToServerMessage = Extract<WorkerInboundMessage, { type: 'SYNC_TO_SERVER' }>

type WorkerDatabase = {
	get: (fileId: number) => Promise<Record<string, any> | undefined>
	put: (...args: any[]) => Promise<number>
}

export type SyncWorkerDependencies = {
	database?: WorkerDatabase
	fetchFn?: typeof globalThis.fetch
	postMessage: (message: WorkerOutboundMessage) => void
	now?: () => number
	reportError?: (message: string, ...args: unknown[]) => void
}

const MAX_CONFLICT_RETRIES = 2

const isRecord = (value: unknown): value is Record<string, unknown> => (
	typeof value === 'object'
	&& value !== null
	&& !Array.isArray(value)
)

const defaultNow = () => Date.now()

const getErrorMessage = (error: unknown): string => (
	error instanceof Error
		? error.message
		: String(error)
)

const parseResponseJson = async (response: Response): Promise<unknown> => {
	try {
		return await response.json()
	} catch {
		return undefined
	}
}

const resolveSuccessMeta = (
	responseData: unknown,
	fallbackRev: number,
	fallbackUpdatedAt: number | null,
	fallbackUpdatedBy: string | null,
) => {
	if (!isRecord(responseData) || !isRecord(responseData.meta)) {
		return {
			persistedRev: fallbackRev,
			updatedAt: fallbackUpdatedAt,
			updatedBy: fallbackUpdatedBy,
		}
	}

	return normalizePersistedBoardMeta(responseData.meta)
}

export const createSyncWorkerHandlers = ({
	database,
	fetchFn = globalThis.fetch.bind(globalThis),
	postMessage,
	now = defaultNow,
	reportError = () => undefined,
}: SyncWorkerDependencies) => {
	if (!database) {
		throw new Error('Sync worker database dependency is required')
	}

	const sendMessage = (message: WorkerOutboundMessage) => {
		try {
			postMessage(message)
		} catch (error) {
			reportError(`Failed to send message: ${message.type}`, error)
		}
	}

	const handleSyncToLocal = async (data: SyncToLocalMessage) => {
		const { fileId, elements, files, appState, scrollToContent } = data

		if (!fileId) {
			sendMessage({
				type: 'LOCAL_SYNC_ERROR',
				fileId,
				error: 'Missing fileId for local sync',
			})
			return
		}

		const startedAt = now()

		try {
			await database.put(fileId, [...elements], files || {}, appState, {
				scrollToContent: scrollToContent ?? true,
				hasPendingLocalChanges: true,
			})

			sendMessage({
				type: 'LOCAL_SYNC_COMPLETE',
				fileId,
				duration: now() - startedAt,
				elementsCount: elements.length,
			})
		} catch (error) {
			reportError('Error syncing to local storage:', error)
			sendMessage({
				type: 'LOCAL_SYNC_ERROR',
				fileId,
				error: getErrorMessage(error),
			})
		}
	}

	const handleSyncToServer = async (data: SyncToServerMessage) => {
		const { fileId, url, jwt, elements, files, appState, scrollToContent } = data

		if (!fileId || !url || !jwt) {
			sendMessage({
				type: 'SERVER_SYNC_ERROR',
				fileId,
				error: 'Missing required data for server sync',
			})
			return
		}

		const startedAt = now()
		const existing = await database.get(fileId)
		let currentSnapshot = extractSnapshotFromPersistedBoard({
			elements,
			files: files || {},
			appState,
			scrollToContent,
		})
		let currentBaseRev = existing?.persistedRev ?? 0
		let conflictCount = 0

		try {
			while (true) {
				const response = await fetchFn(url, {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						'X-Requested-With': 'XMLHttpRequest',
						Authorization: `Bearer ${jwt}`,
					},
					body: JSON.stringify({
						data: {
							baseRev: currentBaseRev,
							elements: currentSnapshot.elements,
							files: currentSnapshot.files,
							appState: currentSnapshot.appState,
							scrollToContent: currentSnapshot.scrollToContent,
						},
					}),
				})

				if (response.status === 409) {
					const responseData = await parseResponseJson(response)
					const serverDocument = normalizePersistedBoardDocument(
						isRecord(responseData) ? responseData.data : undefined,
					)
					const serverMeta = serverDocument.meta

					if (areSnapshotsEquivalent(currentSnapshot, serverDocument)) {
						await database.put(
							fileId,
							currentSnapshot.elements,
							currentSnapshot.files,
							currentSnapshot.appState,
							{
								scrollToContent: currentSnapshot.scrollToContent,
								hasPendingLocalChanges: false,
								lastSyncedHash: computeElementVersionHash(serverDocument.elements),
								persistedRev: serverMeta.persistedRev,
								lastServerUpdatedAt: serverMeta.updatedAt,
								lastServerUpdatedBy: serverMeta.updatedBy,
							},
						)

						sendMessage({
							type: 'SERVER_SYNC_COMPLETE',
							fileId,
							success: true,
							conflict: true,
							duration: now() - startedAt,
							elementsCount: currentSnapshot.elements.length,
							response: responseData,
							persistedRev: serverMeta.persistedRev,
							updatedAt: serverMeta.updatedAt,
							updatedBy: serverMeta.updatedBy,
						})
						return
					}

					const mergedSnapshot = mergeLocalPendingWithServerSnapshot(currentSnapshot, serverDocument)
					await database.put(
						fileId,
						mergedSnapshot.elements,
						mergedSnapshot.files,
						mergedSnapshot.appState,
						{
							scrollToContent: mergedSnapshot.scrollToContent,
							hasPendingLocalChanges: true,
							lastSyncedHash: computeElementVersionHash(serverDocument.elements),
							persistedRev: serverMeta.persistedRev,
							lastServerUpdatedAt: serverMeta.updatedAt,
							lastServerUpdatedBy: serverMeta.updatedBy,
						},
					)

					if (conflictCount >= MAX_CONFLICT_RETRIES) {
						sendMessage({
							type: 'SERVER_SYNC_CONFLICT',
							fileId,
							error: 'Durable sync conflict after retrying rebased snapshot',
							persistedRev: serverMeta.persistedRev,
							updatedAt: serverMeta.updatedAt,
							updatedBy: serverMeta.updatedBy,
						})
						return
					}

					currentSnapshot = mergedSnapshot
					currentBaseRev = serverMeta.persistedRev
					conflictCount++
					continue
				}

				if (!response.ok) {
					let errorMessage = `Server responded with status: ${response.status}`
					try {
						const responseText = await response.text()
						errorMessage += ` - ${responseText}`
					} catch {
						// Ignore parse failures while constructing the error message.
					}
					throw new Error(errorMessage)
				}

				const responseData = await parseResponseJson(response)
				const responseMeta = resolveSuccessMeta(
					responseData,
					currentBaseRev,
					existing?.lastServerUpdatedAt ?? null,
					existing?.lastServerUpdatedBy ?? null,
				)

				await database.put(
					fileId,
					currentSnapshot.elements,
					currentSnapshot.files,
					currentSnapshot.appState,
					{
						scrollToContent: currentSnapshot.scrollToContent,
						hasPendingLocalChanges: false,
						lastSyncedHash: computeElementVersionHash(currentSnapshot.elements),
						persistedRev: responseMeta.persistedRev,
						lastServerUpdatedAt: responseMeta.updatedAt,
						lastServerUpdatedBy: responseMeta.updatedBy,
					},
				)

				sendMessage({
					type: 'SERVER_SYNC_COMPLETE',
					fileId,
					success: true,
					conflict: conflictCount > 0,
					duration: now() - startedAt,
					elementsCount: currentSnapshot.elements.length,
					response: responseData,
					persistedRev: responseMeta.persistedRev,
					updatedAt: responseMeta.updatedAt,
					updatedBy: responseMeta.updatedBy,
				})
				return
			}
		} catch (error) {
			reportError('Error syncing to server:', error)
			sendMessage({
				type: 'SERVER_SYNC_ERROR',
				fileId,
				error: getErrorMessage(error),
			})
		}
	}

	const initWorker = () => {
		try {
			sendMessage({ type: 'INIT_COMPLETE' })
		} catch (error) {
			reportError('Failed to initialize worker:', error)
			sendMessage({
				type: 'INIT_ERROR',
				error: getErrorMessage(error),
			})
		}
	}

	const handleMessage = async (message: WorkerInboundMessage) => {
		switch (message.type) {
		case 'INIT':
			initWorker()
			break
		case 'SYNC_TO_LOCAL':
			await handleSyncToLocal(message)
			break
		case 'SYNC_TO_SERVER':
			await handleSyncToServer(message)
			break
		default:
			break
		}
	}

	return {
		handleMessage,
		handleSyncToLocal,
		handleSyncToServer,
		initWorker,
	}
}
