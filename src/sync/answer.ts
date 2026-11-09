/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@nextcloud/excalidraw/types'
import type { Changes } from './changes.ts'

// `restored`: the epoch began with a version restore
export type BoardRevision = { epoch: string, rev: number, restored?: boolean }

export type BoardContent = {
	elements: ExcalidrawElement[]
	files: BinaryFiles
	appState?: Partial<AppState>
	scrollToContent?: boolean
	[key: string]: unknown
}

/** Why Nextcloud did not take a request, when the person can do something about it */
export type Refusal = 'unauthorized' | 'tooLarge' | 'forbidden' | 'gone' | 'upgrade'

// Busy, refused and failed answers come without `sync`
type ServerAnswer = { sync?: BoardRevision, delta?: Changes, data?: BoardContent, code?: string }

/** Settles once the request is answered, fails, or receives nothing for a minute */
export type BoardRequest = (method: 'GET' | 'PUT', options?: {
	query?: Record<string, string>
	body?: unknown
	keepalive?: boolean
}) => Promise<{ status: number, body: ServerAnswer | null }>

/**
 * What an answer of Nextcloud to a board request means:
 * - `ok`: the board as Nextcloud has it, whole or what changed after the revision the request named
 * - `replaced`: the board started an epoch the request did not know; nothing was stored
 * - `unreadable`: Nextcloud cannot read the stored board; nothing was stored
 * - `busy`: another request is changing the board; nothing was stored
 * - `refused`: refused before anything was stored, as this client is older than the board needs, may not change the board, or the board is gone
 * - `failed`: no answer of the board, as the request failed or its answer cannot be read; Nextcloud may have stored a save.
 *   A token Nextcloud no longer accepts or a request too large for the web server is tried again, with its reason
 */
export type Answer = { kind: 'ok', sync: BoardRevision, data?: BoardContent, delta?: Changes }
	| { kind: 'replaced', sync: BoardRevision }
	| { kind: 'unreadable', sync: BoardRevision }
	| { kind: 'busy' }
	| { kind: 'refused', reason: 'forbidden' | 'gone' | 'upgrade' }
	| { kind: 'failed', reason?: 'unauthorized' | 'tooLarge' }

/**
 * Whether sending the same request again may get another answer: nothing
 * else would change a refusal, a new epoch or an unreadable board
 *
 * @param answer
 */
export function worthRetrying(answer: Answer): boolean {
	return answer.kind === 'busy' || answer.kind === 'failed'
}

/**
 * What an answer means, as `lib/Controller/WhiteboardController.php` and
 * `lib/Service/ExceptionService.php` give it
 *
 * @param response the answer, or null when the request failed
 */
export function readAnswer(response: Awaited<ReturnType<BoardRequest>> | null): Answer {
	const body = response?.body
	switch (response?.status) {
		case 200:
			return body?.sync ? { kind: 'ok', sync: body.sync, data: body.data, delta: body.delta } : { kind: 'failed' }
		case 409:
			if (body?.code === 'board_replaced' && body.sync) {
				return { kind: 'replaced', sync: body.sync }
			}
			return body?.code === 'board_unreadable' && body.sync ? { kind: 'unreadable', sync: body.sync } : { kind: 'failed' }
		case 503:
			return { kind: 'busy' }
		case 400:
			return body?.code === 'client_upgrade_required' ? { kind: 'refused', reason: 'upgrade' } : { kind: 'failed' }
		case 401:
			return { kind: 'failed', reason: 'unauthorized' }
		case 403:
			return { kind: 'refused', reason: 'forbidden' }
		case 404:
			return { kind: 'refused', reason: 'gone' }
		case 413:
			return { kind: 'failed', reason: 'tooLarge' }
		default:
			return { kind: 'failed' }
	}
}
