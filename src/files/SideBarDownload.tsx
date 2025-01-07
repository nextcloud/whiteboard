/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createRoot } from 'react-dom'
import { type JSX } from 'react'
import { type Meta } from './files'
import { mdiDownloadBox } from '@mdi/js'
import { Icon } from '@mdi/react'

/**
 * renders the html button for file downloads
 * @param meta file data
 * @param onClick onClick callback
 * @return {JSX.Element} rendered Button JSX
 */
function renderDownloadButton(meta: Meta, onClick: () => void): JSX.Element {
	const iconUrl = window.OC.MimeType.getIconUrl(meta.type)
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				padding: '10px',
			}}>
			<img
				src={iconUrl}
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
				onClick={onClick}
				style={{ textAlign: 'center', fontWeight: 'bold' }}>
				Download
				<Icon
					path={mdiDownloadBox}
					size={1.5}
					style={{ verticalAlign: 'middle' }}
				/>
			</button>
		</div>
	)
}

/**
 * removes the download button from the sidebar
 * makes all default excalidraw settings visible again
 * @return {void}
 */
export function ResetDownloadButton() {
	const sideBar = document.getElementsByClassName('App-menu__left')[0]
	if (sideBar === undefined) {
		return
	}
	const panelColumn = sideBar.querySelector('.panelColumn') as HTMLElement
	if (panelColumn) {
		panelColumn.style.display = ''
	}
	const downloadButton = document.getElementsByClassName('nc-download')[0]
	if (downloadButton === undefined) {
	 return
	}
	sideBar.removeChild(downloadButton)
}

/**
 * clears the excalidraw sidebar as soon as it appears
 * inserts a download button with the file name instead
 * @param meta file data
 * @param onClick onClick callback
 */
export function InsertDownloadButton(meta: Meta, onClick: () => void) {
	const callback = () => {
		const sideBar = document.getElementsByClassName('App-menu__left')[0]
		if (sideBar === undefined) {
			return
		}
		observer.disconnect()
		const newElement = document.createElement('div')
		newElement.classList.add('nc-download')
		const root = createRoot(newElement)
		root.render(renderDownloadButton(meta, onClick))

		// hide all excalidraw settings
		const panelColumn = sideBar.querySelector('.panelColumn') as HTMLElement
		if (panelColumn) {
			panelColumn.style.display = 'none'
		}

		sideBar.appendChild(newElement)
	}

	const observer = new MutationObserver(callback)

	const sideBar = document.getElementsByClassName('App-menu__left')[0]
	if (sideBar !== undefined) {
		callback()
	} else {
		observer.observe(document.body, { childList: true, subtree: true })
	}
}
