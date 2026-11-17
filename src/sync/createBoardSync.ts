/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BoardRequest, BoardRevision } from './answer.ts'

import { getCurrentUser } from '@nextcloud/auth'
import { showWarning } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'
import { generateUrl } from '@nextcloud/router'
import { useBoardStatusStore } from '../stores/useBoardStatusStore.ts'
import { useCollaborationStore } from '../stores/useCollaborationStore.ts'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { requestBoardToken, useJWTStore } from '../stores/useJwtStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import logger from '../utils/logger.ts'
import { BoardSync, getBoardSync, getLeavingBoards, setBoardSync } from './boardSync.ts'
import { guardLeavingPage } from './leavePage.ts'
import { dropLegacyDraft, legacyDraft, localBoardStore } from './localBoardStore.ts'
import { encodeRoomMessage, sceneNotice } from './roomMessages.ts'

/** Whose IndexedDB entries these are: the public share, or the account */
export function boardAccount(): string {
	const { publicSharingToken } = useWhiteboardConfigStore.getState()
	if (publicSharingToken) {
		return `share:${publicSharingToken}`
	}
	return getCurrentUser()?.uid ?? 'guest'
}

// A board request that receives nothing for this long is aborted; a slow download that keeps receiving goes on
const STALL_TIMEOUT = 60_000

/**
 * The token for requests about a board. A board that closed while another
 * one opened sends its last save with its own token, never the open board's.
 *
 * @param fileId
 * @param keepalive a closing page cannot wait for a token request
 */
async function boardToken(fileId: number, keepalive = false): Promise<string | null> {
	const store = useJWTStore.getState()
	if (!keepalive && useWhiteboardConfigStore.getState().fileId === fileId) {
		return store.getJWT()
	}
	if (!store.isTokenExpired(String(fileId))) {
		return store.tokens[fileId] ?? null
	}
	return keepalive ? null : closedBoardToken(fileId)
}

/**
 * A new token for a board closed in the page, which leaves the token and
 * the permissions of the open board as they are
 *
 * @param fileId
 */
async function closedBoardToken(fileId: number): Promise<string | null> {
	return requestBoardToken(fileId, useWhiteboardConfigStore.getState().publicSharingToken).catch(() => null)
}

function boardRequest(fileId: number): BoardRequest {
	const send = async (jwt: string, method: Parameters<BoardRequest>[0], { query, body, keepalive }: NonNullable<Parameters<BoardRequest>[1]>) => {
		const url = generateUrl(`apps/whiteboard/${fileId}`) + (query ? `?${new URLSearchParams(query)}` : '')
		const controller = new AbortController()
		let stalled: ReturnType<typeof setTimeout> | undefined
		// A closing page sends its request without waiting for it
		const progress = () => {
			clearTimeout(stalled)
			stalled = keepalive ? undefined : setTimeout(() => controller.abort(), STALL_TIMEOUT)
		}
		progress()
		try {
			const response = await fetch(url, {
				method,
				keepalive,
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					Authorization: `Bearer ${jwt}`,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})
			progress()
			const text = await readBody(response, progress)
			let answer = null
			try {
				answer = JSON.parse(text)
			} catch {
				// Not an answer of the board API
			}
			return { status: response.status, body: answer }
		} finally {
			clearTimeout(stalled)
		}
	}

	return async (method, options = {}) => {
		const jwt = await boardToken(fileId, options.keepalive)
		if (!jwt) {
			throw new Error('No token for the board')
		}
		const response = await send(jwt, method, options)
		if (response.status !== 401 || options.keepalive) {
			return response
		}
		// The secret changed since the token was made: once more with a new token
		useJWTStore.getState().dropToken(String(fileId))
		const fresh = await boardToken(fileId)
		return fresh ? send(fresh, method, options) : response
	}
}

async function readBody(response: Response, progress: () => void): Promise<string> {
	if (!response.body) {
		return response.text()
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			return text + decoder.decode()
		}
		progress()
		text += decoder.decode(value, { stream: true })
	}
}

/**
 * Tells the room that the board has a new revision, so its tabs fetch it
 *
 * @param fileId
 * @param type
 * @param sync the new epoch and revision; unknown to a page whose board closed for a version preview
 */
export function announce(fileId: number, type: 'saved' | 'restored', sync?: BoardRevision): void {
	const { socket, isInRoom } = useCollaborationStore.getState()
	if (!socket?.connected || !isInRoom) {
		return
	}
	socket.emit('server-broadcast', `${fileId}`, encodeRoomMessage(sceneNotice(type, sync)), [])
}

// Boards whose kept changes were offered since this page loaded
const offeredOnOpen = new Set<number>()
// The notice shown for each board; one at a time, it covers everything kept for the board
const notices = new Set<number>()

function offerRecovery(fileId: number, account: string, opened: boolean): void {
	if ((opened && offeredOnOpen.has(fileId)) || notices.has(fileId)) {
		return
	}
	offeredOnOpen.add(fileId)
	notices.add(fileId)
	const store = localBoardStore.board(account, fileId)
	// What the notice offers; changes kept after it appeared get their own
	const offered = store.recovered().catch(() => null)
	let handled = false
	const toast = showWarning(t('whiteboard', 'Some changes on this device were not saved before the board was replaced. Click here to add them back, or close this message to discard them.'), {
		timeout: -1,
		onClick: async () => {
			handled = true
			toast.hideToast()
			const sync = getBoardSync()
			if (sync?.fileId !== fileId) {
				// The changes are still kept on the device, and offered when the board opens
				offeredOnOpen.delete(fileId)
				return
			}
			try {
				if (await sync.addBack()) {
					return
				}
			} catch (error) {
				logger.warn('[BoardSync] Could not add the kept changes back', error)
			}
			// The changes are still kept on the device
			offerRecovery(fileId, account, false)
		},
		onRemove: () => {
			notices.delete(fileId)
			if (handled) {
				return
			}
			void offered.then(async (recovered) => {
				await store.dropRecovered(recovered?.keys ?? [])
				if ((await store.recovered()).keys.length > 0) {
					offerRecovery(fileId, account, false)
				}
			}).catch(() => {})
		},
	})
}

/**
 * Makes `sync` the board open in this page, after closing the one open so
 * far, and shows its save state; null closes the open board, and nothing is
 * shown of it any more
 *
 * @param sync
 */
export function showBoard(sync: BoardSync | null): void {
	setBoardSync(sync)
	useBoardStatusStore.setState(sync ? { fileId: sync.fileId, status: sync.status } : { fileId: null, status: null })
}

// Installed once: a board closed in the page may still send its last changes
let guarding = false

export function createBoardSync(fileId: number, account: string): BoardSync {
	if (!guarding && typeof window !== 'undefined') {
		guarding = true
		guardLeavingPage(getLeavingBoards, () => localBoardStore.keepsChanges(boardAccount()))
	}
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
		announce: (type, revision) => announce(fileId, type, revision),
		onRecoverable: (opened) => offerRecovery(fileId, account, opened),
		store: localBoardStore.board(account, fileId),
		legacyDraft: { read: () => legacyDraft(fileId), drop: () => dropLegacyDraft(fileId) },
		// Escape submits the text in Excalidraw's editor, also while a click in the properties panel has turned off its blur
		endEditing: () => document.querySelector('textarea.excalidraw-wysiwyg')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
		keepaliveReady: () => !useJWTStore.getState().isTokenExpired(String(fileId)),
		onStatus: (status) => {
			if (getBoardSync() === sync) {
				useBoardStatusStore.setState({ fileId, status })
			}
		},
	})
	return sync
}
