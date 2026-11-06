/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BoardRequest, BoardSyncState } from './boardSync.ts'

import { getCurrentUser } from '@nextcloud/auth'
import { showWarning } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'
import { generateUrl } from '@nextcloud/router'
import { dropLegacyDraft, legacyDraft, localBoardStore } from '../database/localBoardStore.ts'
import { useCollaborationStore } from '../stores/useCollaborationStore.ts'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { useJWTStore } from '../stores/useJwtStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { sceneNotice } from '../utils/sceneSchema.ts'
import { BoardSync, getBoardSync } from './boardSync.ts'

/** Whose IndexedDB entries these are: the public share, or the account */
export function boardAccount(): string {
	const { publicSharingToken } = useWhiteboardConfigStore.getState()
	if (publicSharingToken) {
		return `share:${publicSharingToken}`
	}
	return getCurrentUser()?.uid ?? 'guest'
}

function boardRequest(fileId: number): BoardRequest {
	return async (method, { path, query, body, keepalive } = {}) => {
		// A closing page cannot wait for a token refresh
		const jwt = keepalive ? useJWTStore.getState().tokens[fileId] : await useJWTStore.getState().getJWT()
		if (!jwt) {
			throw new Error('No token for the board')
		}
		const url = generateUrl(`apps/whiteboard/${fileId}${path ? `/${path}` : ''}`) + (query ? `?${new URLSearchParams(query)}` : '')
		const response = await fetch(url, {
			method,
			keepalive,
			headers: {
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				Authorization: `Bearer ${jwt}`,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return { status: response.status, body: await response.json().catch(() => null) }
	}
}

/**
 * Tells the room that the board has a new revision
 *
 * @param fileId
 * @param type
 * @param sync
 */
function announce(fileId: number, type: 'saved' | 'restored', sync: BoardSyncState): void {
	const { socket, isInRoom } = useCollaborationStore.getState()
	if (!socket?.connected || !isInRoom) {
		return
	}
	socket.emit('server-broadcast', `${fileId}`, new TextEncoder().encode(JSON.stringify(sceneNotice(type, sync))), [])
}

// Boards whose kept changes were offered since this page loaded
const offeredOnOpen = new Set<number>()

function offerRecovery(fileId: number, account: string, opened: boolean): void {
	if (opened && offeredOnOpen.has(fileId)) {
		return
	}
	offeredOnOpen.add(fileId)
	showWarning(t('whiteboard', 'Some changes on this device were not saved before the board changed. Click here to add them back.'), {
		timeout: -1,
		onClick: async () => {
			const sync = getBoardSync()
			if (sync?.fileId !== fileId) {
				return
			}
			const recovered = await localBoardStore.recovered(account, fileId)
			if (await sync.addRecovered(recovered)) {
				await localBoardStore.dropRecovered(recovered.keys)
			}
		},
	})
}

export function createBoardSync(fileId: number, account: string): BoardSync {
	const sync: BoardSync = new BoardSync({
		fileId,
		account,
		request: boardRequest(fileId),
		// The editor shows another board once this one is closed
		editor: () => getBoardSync() === sync ? useExcalidrawStore.getState().excalidrawAPI : null,
		isReadOnly: () => useWhiteboardConfigStore.getState().isReadOnly,
		isLeader: () => useCollaborationStore.getState().isDedicatedSyncer,
		isInRoom: () => {
			const { socket, isInRoom } = useCollaborationStore.getState()
			return Boolean(socket?.connected && isInRoom)
		},
		announce: (type, sync) => announce(fileId, type, sync),
		onRecoverable: (opened) => offerRecovery(fileId, account, opened),
		store: localBoardStore,
		legacyDraft: { read: () => legacyDraft(fileId), drop: () => dropLegacyDraft(fileId) },
		endEditing: () => document.querySelector('textarea.excalidraw-wysiwyg')?.dispatchEvent(new Event('blur')),
	})
	return sync
}
