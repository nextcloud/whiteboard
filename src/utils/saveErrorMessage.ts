/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { translate as t } from '@nextcloud/l10n'

export function saveErrorMessage(error: unknown, conflictMessage: string, fallbackMessage: string): string {
	const status = (error as { status?: number }).status
	if (status === 409) {
		return conflictMessage
	}
	// 424: the server could neither find nor create the user's Templates folder
	if (status === 424) {
		return t('whiteboard', 'Your Templates folder could not be found or created. In Files, open the "New" menu, choose "Create templates folder" and try again. If that is not possible, ask your administrator.')
	}
	return fallbackMessage
}
