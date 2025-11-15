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

const handleSyncToLocal = async (data: SyncToLocalMessage) => {
	const { fileId, elements, files, appState } = data

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
			hasPendingLocalChanges: true,
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
	const { fileId, url, jwt, elements, files } = data

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

		if (response.status === 409) {
			sendMessage({
				type: 'SERVER_SYNC_COMPLETE',
				success: true,
				skipped: true,
				duration: 0,
				elementsCount: elements?.length ?? 0,
			})
			return
		}

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

		try {
			const existing = await db.get(fileId)
			await db.put(
				fileId,
				elements,
				files || existing?.files || {},
				existing?.appState,
				{
					hasPendingLocalChanges: false,
					lastSyncedHash: computeElementVersionHash(elements || []),
				},
			)
		} catch (dbError) {
			error('Error updating local metadata after server sync:', dbError)
		}

		const duration = performance.now() - startTime

		sendMessage({
			type: 'SERVER_SYNC_COMPLETE',
			success: true,
			duration,
			elementsCount: elements.length,
			response: responseData,
		})
	} catch (e) {
		error('Error syncing to server:', e)
		sendMessage({
			type: 'SERVER_SYNC_ERROR',
			error: e instanceof Error ? e.message : String(e),
		})
	}
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
			await handleSyncToLocal(message)
			break
		case 'SYNC_TO_SERVER':
			await handleSyncToServer(message)
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
