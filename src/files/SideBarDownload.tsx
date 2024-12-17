import type { Meta } from './files'
import { createRoot } from 'react-dom'
import { mdiDownloadBox } from '@mdi/js'
import { Icon } from '@mdi/react'

function renderDownloadBox(meta: Meta) {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				cursor: 'pointer',
			}}>
			<span style={{ marginRight: '5px', cursor: 'pointer' }}>
				{meta.name}
			</span>
			<Icon path={mdiDownloadBox} size={1} />
		</div>
	)
}

export async function downloadDialog(meta: Meta, onClick: () => void) {
	const observer = new MutationObserver(() => {
		const sideBar = document.getElementsByClassName('App-menu__left')[0]
		if (sideBar !== undefined) {
			observer.disconnect()
		} else {
			return
		}
		const newElement = document.createElement('div')
		const root = createRoot(newElement)
		root.render(renderDownloadBox(meta))
		newElement.addEventListener('click', onClick)

		const panelColumn = sideBar.querySelector('.panelColumn')
		if (panelColumn) {
			panelColumn.insertBefore(newElement, panelColumn.firstChild)
		} else {
			sideBar.appendChild(newElement)
		}
	})
	observer.observe(document.body, { childList: true, subtree: true })
}
