/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BoardSyncStatus } from '../sync/boardSync.ts'

import { create } from 'zustand'

/** The save state of the board open in this page */
export const useBoardStatusStore = create<{ fileId: number | null, status: BoardSyncStatus | null }>(() => ({ fileId: null, status: null }))
