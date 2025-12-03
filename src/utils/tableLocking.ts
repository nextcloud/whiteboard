/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { getCurrentUser } from '@nextcloud/auth'
import { showError } from '@nextcloud/dialogs'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { ExcalidrawImageElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'

const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Structure stored in element.customData.tableLock to track who is editing
 */
export interface TableLock {
	uid: string
	displayName: string
	lockedAt: number
}

/**
 * Checks if a lock has expired based on the 5-minute timeout.
 * @param lock - The lock object to check
 * @return true if the lock is expired or missing, false if still valid
 */
export function isLockExpired(lock: { lockedAt?: number } | undefined): boolean {
	if (!lock || !lock.lockedAt) return true
	return Date.now() - (lock.lockedAt || 0) > LOCK_TIMEOUT_MS
}

/**
 * Sets or clears a lock on a table element by updating its customData.
 *
 * This directly modifies the element's customData.tableLock property and triggers
 * Excalidraw's updateScene(), which automatically syncs the change to all collaborators
 * via the normal onChange flow (websocket + server API).
 *
 * The lock survives reconciliation because mergeElementsWithMetadata explicitly
 * preserves tableLock from whichever element version wins.
 *
 * @param excalidrawAPI - The Excalidraw API instance
 * @param elementId - The ID of the table element to lock/unlock
 * @param lock - The lock object to set, or undefined to clear the lock
 */
export function setLockOnElement(
	excalidrawAPI: ExcalidrawImperativeAPI,
	elementId: string,
	lock: TableLock | undefined,
): void {
	const elements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
	const idx = elements.findIndex(el => el.id === elementId)
	// findIndex() can return -1 if the element does not exist
	if (idx === -1) return

	// Update the element with the new lock state
	elements[idx] = {
		...elements[idx],
		customData: {
			...elements[idx].customData,
			// Set tableLock to the provided value, or explicitly undefined to clear
			...(lock ? { tableLock: lock } : { tableLock: undefined }),
		},
	}
	// Trigger onChange which syncs to other users
	excalidrawAPI.updateScene({ elements })
}

/**
 * Attempts to acquire an edit lock on a table element.
 * @param excalidrawAPI - The Excalidraw API instance
 * @param tableElement - The table element to lock
 * @return true if lock was successfully acquired, false if blocked by another user
 */
export function tryAcquireLock(
	excalidrawAPI: ExcalidrawImperativeAPI,
	tableElement: ExcalidrawImageElement,
): boolean {
	const user = getCurrentUser()
	if (!user) {
		console.error('User not available')
		return false
	}

	// Get the current state of the element (may have been updated by another user)
	const elementsNow = excalidrawAPI.getSceneElementsIncludingDeleted()
	const current = elementsNow.find(el => el.id === tableElement.id)
	const existingLock = current?.customData?.tableLock

	// Check if another user has a valid (non-expired) lock
	if (existingLock && existingLock.uid !== user.uid && !isLockExpired(existingLock)) {
		// Show error to user and prevent editing
		showError(`This table is currently being edited by ${existingLock.displayName}`)
		return false
	}

	// Lock is available - acquire it for this user
	// No heartbeat needed - the lock will expire after 5 minutes if not released
	const lockInfo: TableLock = {
		uid: user.uid,
		displayName: user.displayName || user.uid,
		lockedAt: Date.now(),
	}
	setLockOnElement(excalidrawAPI, tableElement.id, lockInfo)
	return true
}

/**
 * Releases a lock on a table element by clearing the tableLock property.
 *
 * This should be called when:
 * - User saves their table edits (lock cleared automatically in editTable)
 * - User cancels the edit dialog
 * - An error occurs during editing
 * @param excalidrawAPI - The Excalidraw API instance
 * @param elementId - The ID of the table element to unlock
 */
export function releaseLock(
	excalidrawAPI: ExcalidrawImperativeAPI,
	elementId: string,
): void {
	try {
		setLockOnElement(excalidrawAPI, elementId, undefined)
	} catch (e) {
		console.error('Failed to release lock:', e)
	}
}
