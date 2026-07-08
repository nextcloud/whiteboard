/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useState } from 'react'
import type { FormEvent } from 'react'
import { translate as t } from '@nextcloud/l10n'

export type SaveScope = 'personal' | 'org'

interface SaveScopedDialogProps {
	title: string
	hint: string
	nameLabel: string
	/** Admins get the personal/organization scope toggle. */
	isAdmin: boolean
	isSaving: boolean
	error: string | null
	onClose: () => void
	onSubmit: (scope: SaveScope, name: string) => void
	/** Called when the user edits the name, to clear a stale error. */
	onErrorClear: () => void
}

/**
 * Name + scope form shared by "Save as library" and "Save as canvas template".
 *
 * @param props Dialog props.
 */
export function SaveScopedDialog(props: SaveScopedDialogProps) {
	const {
		title,
		hint,
		nameLabel,
		isAdmin,
		isSaving,
		error,
		onClose,
		onSubmit,
		onErrorClear,
	} = props
	const [scope, setScope] = useState<SaveScope>('personal')
	const [name, setName] = useState('')

	const close = useCallback(() => {
		if (!isSaving) {
			onClose()
		}
	}, [isSaving, onClose])

	const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!isSaving) {
			onSubmit(scope, name.trim())
		}
	}, [isSaving, onSubmit, scope, name])

	return (
		<div className="save-scoped-dialog__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { close() } }}>
			<form className="save-scoped-dialog" onSubmit={submit}>
				<h2>{title}</h2>
				<p className="save-scoped-dialog__hint">{hint}</p>
				{isAdmin && (
					<fieldset className="save-scoped-dialog__scope" disabled={isSaving}>
						<legend>{t('whiteboard', 'Available to')}</legend>
						<label className="save-scoped-dialog__scope-option">
							<input type="radio" name="save-scope" checked={scope === 'personal'} onChange={() => setScope('personal')} />
							{t('whiteboard', 'Only me')}
						</label>
						<label className="save-scoped-dialog__scope-option">
							<input type="radio" name="save-scope" checked={scope === 'org'} onChange={() => setScope('org')} />
							{t('whiteboard', 'Everyone in the organization')}
						</label>
					</fieldset>
				)}
				<label htmlFor="save-scoped-name">{nameLabel}</label>
				<input
					id="save-scoped-name"
					type="text"
					autoFocus
					value={name}
					disabled={isSaving}
					onChange={(e) => { setName(e.target.value); onErrorClear() }}
				/>
				{error && (
					<p className="save-scoped-dialog__error">{error}</p>
				)}
				<div className="save-scoped-dialog__actions">
					<button type="button" className="save-scoped-dialog__button" disabled={isSaving} onClick={close}>
						{t('whiteboard', 'Cancel')}
					</button>
					<button type="submit" className="save-scoped-dialog__button save-scoped-dialog__button--primary" disabled={isSaving}>
						{isSaving ? t('whiteboard', 'Saving…') : t('whiteboard', 'Save')}
					</button>
				</div>
			</form>
		</div>
	)
}
