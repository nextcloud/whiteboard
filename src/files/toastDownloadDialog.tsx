import { showMessage, ToastType } from '@nextcloud/dialogs'
import { createRoot } from 'react-dom'
import { mdiDownloadBox } from '@mdi/js'
import { Icon } from '@mdi/react'
import { type Meta } from './files'

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

export function downloadDialog(
	meta: Meta,
	onClick: () => void,
	onRemove: () => void,
) {
	const undoContent = document.createElement('div')
	const root = createRoot(undoContent)
	root.render(renderDownloadBox(meta))
	showMessage(undoContent, {
		type: ToastType.INFO,
		close: true,
		onRemove,
		onClick,
	})
}
