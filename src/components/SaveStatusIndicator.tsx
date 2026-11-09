/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Refusal } from '../sync/answer.ts'

import { mdiCloudAlertOutline, mdiCloudCheckOutline, mdiCloudSyncOutline } from '@mdi/js'
import { Icon } from '@mdi/react'
import { getCanonicalLocale, t } from '@nextcloud/l10n'
import { memo, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoardStatusStore } from '../stores/useBoardStatusStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { UNSAVED_LATE_AFTER } from '../sync/boardSync.ts'

function time(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(getCanonicalLocale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * What happens to changes that did not reach Nextcloud, and what the person can do
 *
 * @param reason why the last save did not reach Nextcloud, if known
 * @param since when the oldest of them was made
 */
function notSavedDescription(reason: Refusal | null, since: string): string {
	switch (reason) {
		case 'unauthorized':
			return t('whiteboard', 'Changes made since {time} were not saved because Nextcloud no longer accepts this session. They are kept on this device. Log in again, then reload the board.', { time: since })
		case 'forbidden':
			return t('whiteboard', 'Changes made since {time} were not saved because you can no longer edit this board. They are kept on this device. Ask the owner for edit access, then reload the board.', { time: since })
		case 'gone':
			return t('whiteboard', 'Changes made since {time} were not saved because this board was deleted or is no longer shared with you. They are kept on this device. If it was deleted, restore it from Deleted files and open it again.', { time: since })
		case 'tooLarge':
			return t('whiteboard', 'Changes made since {time} were not saved because they are too large for the server. They are kept on this device. Remove or shrink large images, or ask your administrator to raise the upload limit.', { time: since })
		case 'upgrade':
			return t('whiteboard', 'Changes made since {time} were not saved because this board needs a newer version of Whiteboard. They are kept on this device. Reload the page to update.', { time: since })
		default:
			return t('whiteboard', 'Changes made since {time} have not reached Nextcloud yet. They are kept on this device and saved once Nextcloud can be reached. Keep this page open until then.', { time: since })
	}
}

/** Whether the changes of this tab reached Nextcloud, so people know when it is safe to leave */
export const SaveStatusIndicator = memo(function SaveStatusIndicator() {
	const { fileId, isReadOnly, isVersionPreview } = useWhiteboardConfigStore(useShallow((state) => ({
		fileId: state.fileId,
		isReadOnly: state.isReadOnly,
		isVersionPreview: state.isVersionPreview,
	})))
	const status = useBoardStatusStore((state) => state.fileId === fileId ? state.status : null)
	const [now, setNow] = useState(() => Date.now())
	const [expanded, setExpanded] = useState(false)

	const unsavedSince = status?.unsavedSince ?? null
	useEffect(() => {
		if (unsavedSince === null) {
			return
		}
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 5_000)
		return () => clearInterval(timer)
	}, [unsavedSince])

	if (!status || status.unavailable || isReadOnly || isVersionPreview) {
		return null
	}

	const notSaved = unsavedSince !== null && (status.failed || now - unsavedSince >= UNSAVED_LATE_AFTER)
	const state = notSaved
		? {
				name: 'not-saved',
				icon: mdiCloudAlertOutline,
				text: t('whiteboard', 'Not saved since {time}', { time: time(unsavedSince) }),
				description: notSavedDescription(status.reason, time(unsavedSince)),
			}
		: unsavedSince !== null || status.saving
			? {
					name: 'saving',
					icon: mdiCloudSyncOutline,
					text: t('whiteboard', 'Saving…'),
					description: t('whiteboard', 'Saving your changes to Nextcloud…'),
				}
			: {
					name: 'saved',
					icon: mdiCloudCheckOutline,
					text: t('whiteboard', 'Saved'),
					description: status.savedAt
						? t('whiteboard', 'All changes are saved to Nextcloud (last save at {time}).', { time: time(status.savedAt) })
						: t('whiteboard', 'All changes are saved to Nextcloud.'),
				}
	const open = expanded || notSaved

	return (
		<div
			className={`save-status save-status--${state.name} ${open ? 'save-status--expanded' : ''}`}
			role="status"
			aria-live="polite"
			aria-label={state.text}
			title={state.description}
			tabIndex={0}
			onClick={() => setExpanded((value) => !value)}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					setExpanded((value) => !value)
				}
			}}
		>
			<div className="save-status__icon-container">
				<Icon path={state.icon} size={0.9} aria-hidden="true" />
			</div>
			<div className="save-status__content">
				<span className="save-status__text">{state.text}</span>
			</div>
		</div>
	)
})
