/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, memo } from 'react'
import { Icon } from '@mdi/react'
import { mdiMonitorScreenshot } from '@mdi/js'
import { MainMenu } from '@excalidraw/excalidraw'

interface ExcalidrawMenuProps {
	fileNameWithoutExtension: string
}

export const ExcalidrawMenu = memo(function ExcalidrawMenu({ fileNameWithoutExtension }: ExcalidrawMenuProps) {
	const takeScreenshot = useCallback(() => {
		const canvas = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement
		if (canvas) {
			const dataUrl = canvas.toDataURL('image/png')
			const downloadLink = document.createElement('a')
			downloadLink.href = dataUrl
			downloadLink.download = `${fileNameWithoutExtension} Screenshot.png`
			document.body.appendChild(downloadLink)
			downloadLink.click()
		}
	}, [fileNameWithoutExtension])

	return (
		<MainMenu>
			<MainMenu.DefaultItems.ToggleTheme />
			<MainMenu.DefaultItems.ChangeCanvasBackground />
			<MainMenu.Separator />
			<MainMenu.DefaultItems.SaveAsImage />
			<MainMenu.Item
				icon={<Icon path={mdiMonitorScreenshot} size="16px" />}
				onSelect={takeScreenshot}>
				{'Download screenshot'}
			</MainMenu.Item>
		</MainMenu>
	)
})
