/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getCanonicalLocale, t } from '@nextcloud/l10n'
import { memo } from 'react'
import { useBoardStatusStore } from '../stores/useBoardStatusStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { getBoardSync } from '../sync/boardSync.ts'

/** Covers a board that Nextcloud did not give this tab yet, instead of an empty board that looks editable */
export const BoardUnavailable = memo(function BoardUnavailable() {
	const fileId = useWhiteboardConfigStore((state) => state.fileId)
	const status = useBoardStatusStore((state) => state.fileId === fileId ? state.status : null)
	if (status?.unavailable !== true) {
		return null
	}
	const copyAt = status.deviceCopyAt
	if (status.reason === 'gone' || status.reason === 'forbidden') {
		return (
			<div className="board-unavailable" role="alert">
				<p className="board-unavailable__title">{t('whiteboard', 'This board could not be loaded')}</p>
				<p>
					{status.reason === 'gone'
						? t('whiteboard', 'This board was deleted or is no longer shared with you. If it was deleted, restore it from Deleted files, then reload the page.')
						: t('whiteboard', 'You no longer have access to this board. Ask the owner to share it with you again, then reload the page.')}
				</p>
			</div>
		)
	}
	let message = t('whiteboard', 'Trying again in the background. If this does not go away, check your connection or ask your administrator.')
	if (copyAt !== null) {
		message = t('whiteboard', 'Nextcloud cannot read the stored file. Replace it with the copy on this device, or restore an earlier version of the file in Files.')
	} else if (status.reason === 'unreadable') {
		message = t('whiteboard', 'Nextcloud cannot read the stored file. Restore an earlier version of the file in Files, or ask its owner to.')
	}
	return (
		<div className="board-unavailable" role="alert">
			<p className="board-unavailable__title">{t('whiteboard', 'This board could not be loaded')}</p>
			<p>{message}</p>
			{copyAt !== null && (
				<button type="button" className="primary" onClick={() => getBoardSync()?.replaceWithDeviceCopy()}>
					{t('whiteboard', 'Replace it with the copy on this device from {date}', {
						date: new Date(copyAt).toLocaleString(getCanonicalLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
					})}
				</button>
			)}
			<button type="button" onClick={() => void getBoardSync()?.fetch()}>{t('whiteboard', 'Try again')}</button>
		</div>
	)
})
