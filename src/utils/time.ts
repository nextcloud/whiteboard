/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { t } from '@nextcloud/l10n'

export function getRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)

	if (seconds < 60) return t('whiteboard', 'Just now')
	if (minutes < 60) return `${minutes} ${minutes === 1 ? t('whiteboard', 'minute ago') : t('whiteboard', 'minutes ago')}`
	if (hours < 24) return `${hours} ${hours === 1 ? t('whiteboard', 'hour ago') : t('whiteboard', 'hours ago')}`
	return `${days} days ago`
}
