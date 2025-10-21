/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from '../database/db'
import { hashElementsVersion } from '../util'

const ctx: Worker = self as any

interface SyncWorkerMessage {
	type: string
	[key: string]: any
}

let performance: Performance
try {
	performance = self.performance
} catch (e) {
	performance = {
		now: () => Date.now(),
	} as any
}

// Logging disabled in production to reduce noise
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = () => {
	// No-op
}

const error = (message: string, ...args: any[]) => {
	try {
		// Only log errors as they are critical
		globalThis.console.error(`[SyncWorker] ${message}`, ...args)
	} catch (e) {}
}

const sendMessage = (type: string, data: any = {}) => {
	try {
		ctx.postMessage({
			type,
			...data,
		})
	} catch (e) {
		error(`Failed to send message: ${type}`, e)
	}
}

const handleMessage = async (event: MessageEvent<SyncWorkerMessage>) => {
	const { type, ...data } = event.data

	try {
		switch (type) {
		case 'INIT':
			initWorker()
			break
		case 'SYNC_TO_LOCAL':
			await handleSyncToLocal(data)
			break
		case 'SYNC_TO_SERVER':
			await handleSyncToServer(data)
			break
		default:
			// Unknown message type - ignore
		}
	} catch (e) {
		error(`Error handling message ${type}:`, e)
		sendMessage(
			`${type === 'SYNC_TO_LOCAL' ? 'LOCAL_SYNC_ERROR' : 'SERVER_SYNC_ERROR'}`,
			{
				error: e instanceof Error ? e.message : String(e),
			},
		)
	}
}

const handleSyncToLocal = async (data: any) => {
	const { fileId, elements, files, appState } = data

	if (!fileId) {
		error('Missing fileId for local sync')
		sendMessage('LOCAL_SYNC_ERROR', {
			error: 'Missing fileId for local sync',
		})
		return
	}

	// We used to prevent syncing empty whiteboards, but this caused issues with deleting all elements
	// Now we allow empty element arrays to be saved, which is necessary when all elements are deleted

	const startTime = performance.now()

	try {

		const filteredAppState = appState ? { ...appState } : appState

		if (filteredAppState && filteredAppState.collaborators) {
			delete filteredAppState.collaborators
		}

		await db.put(fileId, elements, files || {}, filteredAppState, {
			hasPendingLocalChanges: true,
		})

		const endTime = performance.now()
		const duration = endTime - startTime

		sendMessage('LOCAL_SYNC_COMPLETE', {
			duration,
			elementsCount: elements.length,
		})
	} catch (e) {
		error('Error syncing to local storage:', e)
		sendMessage('LOCAL_SYNC_ERROR', {
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const handleSyncToServer = async (data: any) => {
	const { fileId, url, jwt, elements, files } = data

	if (!fileId || !url || !jwt) {
		error('Missing required data for server sync', { fileId, url: !!url, jwt: !!jwt })
		sendMessage('SERVER_SYNC_ERROR', {
			error: 'Missing required data for server sync',
		})
		return
	}

	const startTime = performance.now()
	// Logging disabled in production
	// console.log('[SyncWorker] Starting server sync, fileId:', fileId, 'elements:', elements?.length)

	try {

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			Authorization: `Bearer ${jwt}`,
		}

		// console.log('[SyncWorker] Sending PUT request to:', url)
		const response = await globalThis.fetch(url, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				data: { elements, files: files || {} },
			}),
		})

		if (response.status === 409) {
			// Another sync in progress - just treat as success
			sendMessage('SERVER_SYNC_COMPLETE', {
				success: true,
				skipped: true,
			})
			return
		}

		if (!response.ok) {
			let errorMessage = `Server responded with status: ${response.status}`
			try {
				const responseText = await response.text()
				errorMessage += ` - ${responseText}`
			} catch (textError) {

			}
			throw new Error(errorMessage)
		}

		let responseData
		try {
			responseData = await response.json()
		} catch (parseError) {
			// Could not parse server response, but sync was successful
		}

		const endTime = performance.now()
		const duration = endTime - startTime

		try {
			const existing = await db.get(fileId)
			await db.put(
				fileId,
				elements,
				files || existing?.files || {},
				existing?.appState,
				{
					hasPendingLocalChanges: false,
					lastSyncedHash: hashElementsVersion(elements || []),
				},
			)
		} catch (dbError) {
			error('Error updating local metadata after server sync:', dbError)
		}

		sendMessage('SERVER_SYNC_COMPLETE', {
			success: true,
			duration,
			elementsCount: elements.length,
			response: responseData,
		})
	} catch (e) {
		error('Error syncing to server:', e)
		sendMessage('SERVER_SYNC_ERROR', {
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const initWorker = () => {
	try {
		sendMessage('INIT_COMPLETE')
	} catch (e) {
		error('Failed to initialize worker:', e)
		sendMessage('INIT_ERROR', {
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

ctx.addEventListener('message', handleMessage)
