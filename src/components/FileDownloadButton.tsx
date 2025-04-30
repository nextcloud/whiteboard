/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { FC, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@mdi/react'
import { mdiDownloadBox } from '@mdi/js'
import type { Meta } from '../hooks/useFiles'

interface FileDownloadButtonProps {
  meta: Meta
  onDownload: (meta: Meta) => void
}

export const FileDownloadButton: FC<FileDownloadButtonProps> = ({ meta, onDownload }) => {
	const [container, setContainer] = useState<HTMLElement | null>(null)
	const [, setPanelColumnElement] = useState<HTMLElement | null>(null)

	useEffect(() => {
		// Find the sidebar container
		const sideBar = document.querySelector('.App-menu__left')
		if (!sideBar) return

		// Find the panel column that needs to be hidden
		const panelColumn = sideBar.querySelector('.panelColumn') as HTMLElement
		if (panelColumn) {
			// Save original display style to restore later
			panelColumn.dataset.originalDisplay = panelColumn.style.display
			panelColumn.style.display = 'none'
			setPanelColumnElement(panelColumn)
		}

		// Create container for our download button
		const downloadContainer = document.createElement('div')
		downloadContainer.classList.add('nc-download')
		sideBar.appendChild(downloadContainer)

		setContainer(downloadContainer)

		// Cleanup on unmount
		return () => {
			if (panelColumn && panelColumn.dataset.originalDisplay !== undefined) {
				panelColumn.style.display = panelColumn.dataset.originalDisplay
				delete panelColumn.dataset.originalDisplay
			}

			if (downloadContainer && downloadContainer.parentNode) {
				downloadContainer.parentNode.removeChild(downloadContainer)
			}
		}
	}, [])

	// Only render when we have a container
	if (!container) return null

	// Use createPortal to render into our container
	return createPortal(
		<div style={{
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			padding: '10px',
		}}>
			<img
				src={window.OC.MimeType.getIconUrl(meta.type)}
				style={{
					width: '50px',
					height: '50px',
					marginBottom: '10px',
				}}
			/>
			<span
				style={{
					marginBottom: '5px',
					textAlign: 'center',
					fontWeight: 'bold',
				}}>
				{meta.name}
			</span>
			<button
				onClick={() => onDownload(meta)}
				style={{ textAlign: 'center', fontWeight: 'bold' }}>
        Download
				<Icon
					path={mdiDownloadBox}
					size={1.5}
					style={{ verticalAlign: 'middle' }}
				/>
			</button>
		</div>,
		container,
	)
}
