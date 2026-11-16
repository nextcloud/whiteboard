/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { t } from '@nextcloud/l10n'
import { memo } from 'react'
import { useBoardStatusStore } from '../stores/useBoardStatusStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { getBoardSync } from '../sync/boardSync.ts'

/** Covers a board that Nextcloud did not give this tab yet, instead of an empty board that looks editable */
export const BoardUnavailable = memo(function BoardUnavailable() {
	const fileId = useWhiteboardConfigStore((state) => state.fileId)
	const unavailable = useBoardStatusStore((state) => state.fileId === fileId && state.status?.unavailable === true)
	if (!unavailable) {
		return null
	}
	return (
		<div className="board-unavailable" role="alert">
			<p className="board-unavailable__title">{t('whiteboard', 'This board could not be loaded')}</p>
			<p>{t('whiteboard', 'Trying again in the background. If this does not go away, check your connection or ask your administrator.')}</p>
			<button type="button" onClick={() => void getBoardSync()?.fetch()}>{t('whiteboard', 'Try again')}</button>
		</div>
	)
})
