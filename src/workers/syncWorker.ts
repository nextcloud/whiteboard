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
		sendMessage('ERROR', {
			error: e instanceof Error ? e.message : String(e),
			type,
		})
	}
}

const handleSyncToLocal = async (data: any) => {
	const { fileId, elements, files, appState } = data

	if (!fileId || !elements) {
		error('Missing required data for local sync', {
			fileId,
			elementsCount: elements?.length,
		})
		sendMessage('ERROR', {
			operation: 'SYNC_TO_LOCAL',
			error: 'Missing required data for local sync',
		})
		return
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

		await db.put(fileId, elements, files, filteredAppState)

		const endTime = performance.now()
		const duration = endTime - startTime

		log(`Local sync completed in ${duration.toFixed(2)}ms`)
		sendMessage('LOCAL_SYNC_COMPLETE', {
			duration,
			elementsCount: elements.length,
		})
	} catch (e) {
		error('Error syncing to local storage:', e)
		sendMessage('ERROR', {
			operation: 'SYNC_TO_LOCAL',
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const handleSyncToServer = async (data: any) => {
	const { fileId, url, jwt, elements, files } = data

	if (!fileId || !url) {
		error('Missing required data for server sync', { fileId, url: !!url })
		sendMessage('ERROR', {
			operation: 'SYNC_TO_SERVER',
			error: 'Missing required data for server sync',
		})
		return
	}

	if (!jwt) {
		error('Missing JWT token for server sync')
		sendMessage('ERROR', {
			operation: 'SYNC_TO_SERVER',
			error: 'Missing JWT token for authentication',
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
				data: { elements, files },
			}),
		})

		if (!response.ok) {
			const responseText = await response.text()
			throw new Error(
				`Server responded with status: ${response.status} - ${responseText}`,
			)
		}

		const responseData = await response.json()
		const endTime = performance.now()
		const duration = endTime - startTime

		log(`Server sync completed successfully in ${duration.toFixed(2)}ms`)

		sendMessage('SERVER_SYNC_COMPLETE', {
			success: true,
			duration,
			elementsCount: elements.length,
			response: responseData,
		})
	} catch (e) {
		error('Error syncing to server:', e)
		sendMessage('ERROR', {
			operation: 'SYNC_TO_SERVER',
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

const initWorker = () => {
	log('Initializing sync worker')

	globalThis.addEventListener('error', (e) => {
		error('Unhandled error in worker:', e)
	})
	globalThis.addEventListener('unhandledrejection', (e) => {
		error('Unhandled promise rejection in worker:', e)
	})

	sendMessage('INIT_COMPLETE')
}

ctx.addEventListener('message', (event: MessageEvent<SyncWorkerMessage>) => {
	const { type } = event.data

	if (type === 'INIT' || type === 'INIT_WORKER') {
		initWorker()
	} else {
		handleMessage(event)
	}
})

log('Sync worker loaded')
