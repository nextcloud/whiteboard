/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BoardSync } from './boardSync.ts'

import { t } from '@nextcloud/l10n'

type LeavingBoard = Pick<BoardSync, 'flush' | 'save' | 'hasUnsavedChanges' | 'saveNow' | 'hasUnsavedOnDevice'>

// Logging out clears this device's copies, so it waits this long for the save
const LOGOUT_WAIT = 10_000

/**
 * Keeps unsaved changes when the page goes: the boards send them with a
 * request that outlives the page, the browser asks before leaving when they
 * do not fit such a request, and a logout waits for them to be saved, because
 * the login page then clears this device's copies; when the device still
 * keeps changes Nextcloud does not have, it asks before logging out.
 *
 * @param boards the board open in the page, and boards closed in it that still have changes
 * @param kept whether this device keeps changes Nextcloud does not have, of any board
 * @param navigate opens the logout link once the boards are saved
 * @param confirm asks whether to log out with changes not saved
 * @return stops guarding
 */
export function guardLeavingPage(
	boards: () => LeavingBoard[],
	kept: () => Promise<boolean>,
	navigate = (url: string) => window.location.assign(url),
	confirm = (message: string) => window.confirm(message),
): () => void {
	// The person chose to log out with changes not saved; the browser does not ask again
	let loggingOut = false
	const beforeUnload = (event: BeforeUnloadEvent) => {
		const stuck = boards().filter((sync) => !sync.flush())
		if (stuck.length > 0 && !loggingOut) {
			event.preventDefault()
			event.returnValue = ''
			stuck.forEach((sync) => void sync.save())
		}
	}
	const pageHide = () => {
		boards().forEach((sync) => sync.flush())
	}
	const click = (event: MouseEvent) => {
		const leaving = boards()
		const link = event.target instanceof Element ? event.target.closest('a[href]') as HTMLAnchorElement | null : null
		if (!link || event.defaultPrevented || event.button !== 0 || !isLogout(link)) {
			return
		}
		event.preventDefault()
		event.stopImmediatePropagation()
		let timer: ReturnType<typeof setTimeout> | undefined
		const waited = new Promise((resolve) => {
			timer = setTimeout(resolve, LOGOUT_WAIT)
		})
		const saved = Promise.all(leaving.map((sync) => sync.hasUnsavedChanges() ? sync.saveNow().catch(() => false) : true))
		void Promise.race([saved, waited]).then(async () => {
			clearTimeout(timer)
			const unsaved = await Promise.all(leaving.map((sync) => sync.hasUnsavedOnDevice().catch(() => true)))
			if ((unsaved.some(Boolean) || await kept().catch(() => true)) && !confirm(t('whiteboard', 'Some changes on this board are not saved yet and will be lost. Log out anyway?'))) {
				return
			}
			loggingOut = true
			navigate(link.href)
		})
	}

	window.addEventListener('beforeunload', beforeUnload)
	window.addEventListener('pagehide', pageHide)
	document.addEventListener('click', click, true)
	return () => {
		window.removeEventListener('beforeunload', beforeUnload)
		window.removeEventListener('pagehide', pageHide)
		document.removeEventListener('click', click, true)
	}
}

function isLogout(link: HTMLAnchorElement): boolean {
	try {
		return new URL(link.href, window.location.href).pathname.replace(/\/$/, '').endsWith('/logout')
	} catch {
		return false
	}
}
