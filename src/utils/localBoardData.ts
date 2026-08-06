/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type LocalBoardDataPolicy = 'reconcile' | 'fallback' | 'ignore'

export function getLocalBoardDataPolicy(
	hasServerData: boolean,
	hasLocalData: boolean,
	hasPendingLocalChanges: boolean,
	isReadOnly: boolean,
): LocalBoardDataPolicy {
	if (isReadOnly) {
		return 'ignore'
	}
	if (hasServerData && hasLocalData && hasPendingLocalChanges) {
		return 'reconcile'
	}
	return !hasServerData && hasLocalData ? 'fallback' : 'ignore'
}
