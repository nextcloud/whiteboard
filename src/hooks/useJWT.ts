/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import { useJWTStore } from '../stores/jwtStore'

export const useJWT = () => {
	const {
		getJWT: storeGetJWT,
		refreshJWT: storeRefreshJWT,
		clearJWT: storeClearJWT,
	} = useJWTStore()

	const getJWT = useCallback(
		(roomId: string, publicSharingToken: string | null = null) => {
			return storeGetJWT(roomId, publicSharingToken)
		},
		[storeGetJWT],
	)

	const refreshJWT = useCallback(
		(roomId: string, publicSharingToken: string | null = null) => {
			return storeRefreshJWT(roomId, publicSharingToken)
		},
		[storeRefreshJWT],
	)

	const clearJWT = useCallback(
		(roomId: string) => {
			storeClearJWT(roomId)
		},
		[storeClearJWT],
	)

	return {
		getJWT,
		refreshJWT,
		clearJWT,
	}
}
