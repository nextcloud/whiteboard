/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { db } from '../database/db'
import { computeElementVersionHash } from '../utils/syncSceneData'
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../types/protocol'

const ctx: Worker = self as unknown as Worker

let performance: Performance
try {
	performance = self.performance
} catch {
	performance = {
		now: () => Date.now(),
	} as Performance
}

// Logging disabled in production to reduce noise
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = () => {
	// No-op
}

const error = (message: string, ...args: unknown[]) => {
	try {
		globalThis.console.error(`[SyncWorker] ${message}`, ...args)
	} catch {
		// Ignore logging errors inside worker
	}
}

const sendMessage = (message: WorkerOutboundMessage) => {
	try {
		ctx.postMessage(message)
	} catch (e) {
		error(`Failed to send message: ${message.type}`, e)
	}
}

type SyncToLocalMessage = Extract<WorkerInboundMessage, { type: 'SYNC_TO_LOCAL' }>
type SyncToServerMessage = Extract<WorkerInboundMessage, { type: 'SYNC_TO_SERVER' }>

const waitingServerSyncs = new Map<number, SyncToServerMessage>()
// Per board: its uploads run one at a time, and so do its IndexedDB writes
const serverSyncs = new Map<number, Promise<void>>()
const localSyncs = new Map<number, Promise<void>>()

function queueLocal(fileId: number, task: () => Promise<void>): Promise<void> {
	const done = (localSyncs.get(fileId) ?? Promise.resolve()).then(task)
	localSyncs.set(fileId, done)
	return done
}

const handleSyncToLocal = async (data: SyncToLocalMessage) => {
	const { fileId, elements, files, appState, hasPendingLocalChanges } = data

	if (!fileId) {
		error('Missing fileId for local sync')
		sendMessage({
			type: 'LOCAL_SYNC_ERROR',
			error: 'Missing fileId for local sync',
		})
		return
	}

	const startTime = performance.now()

	try {
		const filteredAppState = appState ? { ...appState } : appState

		if (filteredAppState && filteredAppState.collaborators) {
			delete filteredAppState.collaborators
		}

		await db.put(fileId, elements, files || {}, filteredAppState, {
			hasPendingLocalChanges,
		})

		const duration = performance.now() - startTime

		sendMessage({
			type: 'LOCAL_SYNC_COMPLETE',
			duration,
			elementsCount: elements.length,
		})
	} catch (e) {
		error('Error syncing to local storage:', e)
		sendMessage({
			type: 'LOCAL_SYNC_ERROR',
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const handleSyncToServer = async (data: SyncToServerMessage) => {
	const { fileId, url, jwt, elements, files, sceneKey } = data

	if (!fileId || !url || !jwt) {
		error('Missing required data for server sync', { fileId, url: !!url, jwt: !!jwt })
		sendMessage({
			type: 'SERVER_SYNC_ERROR',
			error: 'Missing required data for server sync',
		})
		return
	}

	const startTime = performance.now()

	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			Authorization: `Bearer ${jwt}`,
		}

		const response = await globalThis.fetch(url, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				data: { elements, files: files || {} },
			}),
		})

		if (!response.ok) {
			let errorMessage = `Server responded with status: ${response.status}`
			try {
				const responseText = await response.text()
				errorMessage += ` - ${responseText}`
			} catch {
				// Ignore parse errors
			}
			throw new Error(errorMessage)
		}

		let responseData: unknown
		try {
			responseData = await response.json()
		} catch {
			// Non-JSON response still counts as success
		}

		await queueLocal(fileId, async () => {
			try {
				const existing = await db.get(fileId)
				const savedHash = computeElementVersionHash(elements || [])
				const hasOtherLocalDraft = existing?.hasPendingLocalChanges
					&& computeElementVersionHash(existing.elements || []) !== savedHash
				if (!hasOtherLocalDraft) {
					await db.put(
						fileId,
						elements,
						files || existing?.files || {},
						existing?.appState,
						{
							hasPendingLocalChanges: false,
							lastSyncedHash: savedHash,
						},
					)
				}
			} catch (dbError) {
				error('Error updating local metadata after server sync:', dbError)
			}
		})

		const duration = performance.now() - startTime

		sendMessage({
			type: 'SERVER_SYNC_COMPLETE',
			success: true,
			duration,
			elementsCount: elements.length,
			response: responseData,
			fileId,
			sceneKey,
		})
	} catch (e) {
		error('Error syncing to server:', e)
		sendMessage({
			type: 'SERVER_SYNC_ERROR',
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

// A newer scene of a board replaces the one still waiting for its upload
function queueSyncToServer(message: SyncToServerMessage): Promise<void> {
	const { fileId } = message
	const isWaiting = waitingServerSyncs.has(fileId)
	waitingServerSyncs.set(fileId, message)
	if (!isWaiting) {
		serverSyncs.set(fileId, (serverSyncs.get(fileId) ?? Promise.resolve()).then(async () => {
			const next = waitingServerSyncs.get(fileId)
			waitingServerSyncs.delete(fileId)
			if (next) {
				await handleSyncToServer(next)
			}
		}))
	}
	return serverSyncs.get(fileId) ?? Promise.resolve()
}

// Resolves once the board's IndexedDB writes are done; with `server`, also
// once its running and waiting uploads are done
async function flushBoard(fileId: number, server: boolean): Promise<void> {
	if (server) {
		await serverSyncs.get(fileId)
	}
	await localSyncs.get(fileId)
}

const initWorker = () => {
	try {
		sendMessage({ type: 'INIT_COMPLETE' })
	} catch (e) {
		error('Failed to initialize worker:', e)
		sendMessage({
			type: 'INIT_ERROR',
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const handleMessage = async (event: MessageEvent<WorkerInboundMessage>) => {
	const message = event.data

	try {
		switch (message.type) {
			case 'INIT':
				initWorker()
				break
			case 'SYNC_TO_LOCAL':
				await queueLocal(message.fileId, () => handleSyncToLocal(message))
				break
			case 'SYNC_TO_SERVER':
				await queueSyncToServer(message)
				break
			case 'FLUSH':
				await flushBoard(message.fileId, message.server)
				sendMessage({ type: 'FLUSH_COMPLETE', id: message.id })
				break
			case 'CANCEL_SERVER_SYNC':
				waitingServerSyncs.delete(message.fileId)
				break
			default:
				// Unknown message type - ignore
		}
	} catch (e) {
		error(`Error handling message ${message.type}:`, e)
		const errorMessage = e instanceof Error ? e.message : String(e)

		if (message.type === 'SYNC_TO_LOCAL') {
			sendMessage({ type: 'LOCAL_SYNC_ERROR', error: errorMessage })
		} else if (message.type === 'SYNC_TO_SERVER') {
			sendMessage({ type: 'SERVER_SYNC_ERROR', error: errorMessage })
		} else {
			sendMessage({ type: 'INIT_ERROR', error: errorMessage })
		}
	}
}

ctx.addEventListener('message', handleMessage)
