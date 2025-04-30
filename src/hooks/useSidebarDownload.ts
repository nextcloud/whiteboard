/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useState, useCallback } from 'react'
import type { Meta } from './useFiles'

export function useSidebarDownload(downloadFile: (meta: Meta) => void) {
	const [activeMeta, setActiveMeta] = useState<Meta | null>(null)

	const showDownloadButton = useCallback((meta: Meta) => {
		setActiveMeta(meta)
	}, [])

	const hideDownloadButton = useCallback(() => {
		setActiveMeta(null)
	}, [])

	const handleDownload = useCallback(
		(meta: Meta) => {
			downloadFile(meta)

			// hideDownloadButton()
		},
		[downloadFile],
	)

	return {
		activeMeta,
		showDownloadButton,
		hideDownloadButton,
		handleDownload,
	}
}
