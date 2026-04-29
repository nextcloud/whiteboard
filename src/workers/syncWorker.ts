/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { db } from '../database/db'
import type { WorkerInboundMessage } from '../types/protocol'
import { createSyncWorkerHandlers } from './syncWorkerCore'

const ctx: Worker = self as unknown as Worker

const reportError = (message: string, ...args: unknown[]) => {
	try {
		globalThis.console.error(`[SyncWorker] ${message}`, ...args)
	} catch {
		// Ignore logging failures inside worker runtime.
	}
}

const now = () => {
	try {
		return self.performance.now()
	} catch {
		return Date.now()
	}
}

const handlers = createSyncWorkerHandlers({
	database: db,
	postMessage: (message) => ctx.postMessage(message),
	now,
	reportError,
})

ctx.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
	void handlers.handleMessage(event.data).catch((error) => {
		reportError('Unhandled worker message error:', error)
	})
})
