/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from '../database/db'

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

const log = (message: string, ...args: any[]) => {
	try {
		globalThis.console.log(`[SyncWorker] ${message}`, ...args)
	} catch (e) {}
}

const error = (message: string, ...args: any[]) => {
	try {
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

	log(`Received message: ${type}`)

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
			log(`Unknown message type: ${type}`)
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

	// Check if we're trying to sync an empty whiteboard
	if (elements.length === 0) {
		try {
			// Check if there's existing data with elements before overwriting
			const existingData = await db.get(fileId)
			if (existingData && existingData.elements && existingData.elements.length > 0) {
				log('[Worker] Preventing sync of empty whiteboard over existing data')
				sendMessage('LOCAL_SYNC_COMPLETE', {
					duration: 0,
					elementsCount: existingData.elements.length,
					skipped: true,
				})
				return
			}
		} catch (error) {
			error('[Worker] Error checking existing data:', error)
			// Continue with the sync operation
		}
	}

	const startTime = performance.now()

	try {
		log(
			`Syncing ${elements.length} elements to local storage for file ${fileId}`,
		)

		const filteredAppState = appState ? { ...appState } : appState

		if (filteredAppState && filteredAppState.collaborators) {
			log('Removing collaborators from appState before storing')
			delete filteredAppState.collaborators
		}

		await db.put(fileId, elements, files || {}, filteredAppState)

		const endTime = performance.now()
		const duration = endTime - startTime

		log(`Local sync completed in ${duration.toFixed(2)}ms for ${elements.length} elements`)
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

	try {
		log(`Sending ${elements.length} elements to server for file ${fileId}`)

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
			} catch (textError) {

			}
			throw new Error(errorMessage)
		}

		let responseData
		try {
			responseData = await response.json()
		} catch (parseError) {
			log('Could not parse server response, but sync was successful')
		}

		const endTime = performance.now()
		const duration = endTime - startTime

		log(`Server sync completed successfully in ${duration.toFixed(2)}ms for ${elements.length} elements`)

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
	log('Initializing worker')
	try {
		sendMessage('INIT_COMPLETE')
		log('Worker initialization completed')
	} catch (e) {
		error('Failed to initialize worker:', e)
		sendMessage('INIT_ERROR', {
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

ctx.addEventListener('message', handleMessage)

log('Sync worker loaded')
