/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { formatRelativeTime, t } from '@nextcloud/l10n'

export function getRelativeTime(timestamp: number): string {
	return formatRelativeTime(timestamp, {
		ignoreSeconds: t('whiteboard', 'Just now'),
	})
}
