/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { showMessage, ToastType } from '@nextcloud/dialogs'
import type {
	BinaryFileData,
	DataURL,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types/types'
import { Collab } from '../collaboration/collab'
import type { FileId } from '@excalidraw/excalidraw/types/element/types'
import axios from '@nextcloud/axios'
import { createRoot } from 'react-dom'
import { mdiDownloadBox } from '@mdi/js'
import { Icon } from '@mdi/react'

type Meta = {
	name: string,
	type: string,
	lastModified: number,
	fileId: string,
}

export class FileHandle {

	private collab: Collab
	private excalidrawApi: ExcalidrawImperativeAPI
	private types: string[]
	private openDownloadToasts: string[]
	constructor(
		excalidrawApi: ExcalidrawImperativeAPI,
		collab: Collab,
		types: string[],
	) {
		this.openDownloadToasts = []
		this.collab = collab
		this.excalidrawApi = excalidrawApi
		this.types = types
		const containerRef = document.getElementsByClassName(
			'excalidraw-container',
		)[0]
		if (containerRef) {
			containerRef.addEventListener('drop', (ev) =>
				this.filesDragEventListener(ev),
			)
		}
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		this.excalidrawApi.onPointerDown((activeTool, state, event) => {
			const clickedElement = state.hit.element
			if (!clickedElement || !clickedElement.customData) {
				return
			}
			this.downloadDialog(clickedElement.customData.meta)
		})
	}

	private renderDownloadBox(meta: Meta) {
		return (
			<div style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
				<span style={{ marginRight: '5px', cursor: 'pointer' }}>
					{meta.name}
				</span>
				<Icon path={mdiDownloadBox} size={1} />
			</div>
		)
	}

	private downloadDialog(meta: Meta) {
		if (this.openDownloadToasts.indexOf(meta.fileId) !== -1) return

		const undoContent = document.createElement('div')
		const root = createRoot(undoContent)
		root.render(this.renderDownloadBox(meta))
		this.openDownloadToasts.push(meta.fileId)
		showMessage(undoContent, {
			type: ToastType.INFO,
			close: true,
			onRemove: () => {
				this.openDownloadToasts = this.openDownloadToasts.filter((val) => val !== meta.fileId)
			},
			onClick: () => { this.downloadFile(meta) },
		})
	}

	private downloadFile(meta: Meta) {
		const file = this.excalidrawApi.getFiles()[meta.fileId]
		const url = file.dataURL
		const a = document.createElement('a')
		a.href = url
		a.download = meta.name
		a.click()
	}

	private filesDragEventListener(ev: Event) {
		if (ev instanceof DragEvent) {
			for (const file of Array.from(ev.dataTransfer?.files || [])) {
				this.handleFileInsert(file, ev)
			}
		}
	}

	private handleFileInsert(file: File, ev: Event) {
		// if excalidraw can handle it, do nothing
		if (this.types.includes(file.type)) {
			return
		}
		ev.stopImmediatePropagation()

		const fr = new FileReader()
		fr.readAsDataURL(file)
		fr.onload = () => {
			const constructedFile: BinaryFileData = {
				mimeType: file.type,
				created: Date.now(),
				id: (Math.random() + 1).toString(36).substring(7) as FileId,
				dataURL: fr.result as DataURL,
			}
			if (typeof fr.result === 'string') {
				const meta: Meta = {
					name: file.name,
					type: file.type,
					lastModified: file.lastModified,
					fileId: constructedFile.id,
				}
				this.addCustomFileElement(constructedFile, meta)
			}
		}
	}

	private async getMimeIcon(mimeType: string): Promise<FileId> {
		let file = this.excalidrawApi.getFiles()[`filetype-icon-${mimeType}`]
		if (!file) {
			const iconUrl = window.OC.MimeType.getIconUrl(mimeType)
			const response = await axios.get(iconUrl, { responseType: 'arraybuffer' })
			const blob = new Blob([response.data], { type: 'image/svg+xml' })

			return new Promise((resolve) => {
				const reader = new FileReader()
				reader.onloadend = () => {
					if (typeof reader.result === 'string') {
						file = {
							mimeType: blob.type,
							id: `filetype-icon-${mimeType}` as FileId,
							dataURL: reader.result as DataURL,
						}
						this.collab.portal.sendImageFiles({ [file.id]: file })
						resolve(file.id)
					}
				}
				reader.readAsDataURL(blob)
			})
		}
		return file.id
	}

	private async addCustomFileElement(constructedFile: BinaryFileData, meta: Meta) {
		const iconId = await this.getMimeIcon(meta.type)
		this.collab.portal.sendImageFiles({ [constructedFile.id]: constructedFile })
		const elements = this.excalidrawApi
			.getSceneElementsIncludingDeleted()
			.slice()
		const newElements = convertToExcalidrawElements([
			{
				type: 'rectangle',
				fillStyle: 'hachure',
				customData: { meta },
				strokeWidth: 1,
				strokeStyle: 'solid',
				opacity: 30,
				x: 0,
				y: 0,
				strokeColor: '#1e1e1e',
				backgroundColor: '#a5d8ff',
				width: 260.62,
				height: 81.57,
				seed: 1641118746,
				groupIds: [meta.fileId],
				roundness: {
					type: 3,
				},
			},
			{
				type: 'image',
				fileId: meta.fileId as FileId,
				x: 28.8678679811,
				y: 16.3505845419,
				width: 1,
				height: 1,
				opacity: 0,
				locked: true,
				groupIds: [meta.fileId],
			},
			{
				type: 'image',
				fileId: iconId,
				x: 28.8678679811,
				y: 16.3505845419,
				width: 48.880073102719564,
				height: 48.880073102719564,
				locked: true,
				groupIds: [meta.fileId],
			},
			{
				type: 'text',
				customData: { meta },
				isDeleted: false,
				fillStyle: 'solid',
				strokeWidth: 1,
				strokeStyle: 'solid',
				opacity: 100,
				x: 85.2856430662,
				y: 28.8678679811,
				strokeColor: '#1e1e1e',
				backgroundColor: 'transparent',
				width: 140.625,
				height: 24,
				seed: 2067517530,
				groupIds: [meta.fileId],
				updated: 1733306011391,
				locked: true,
				fontSize: 20,
				fontFamily: 3,
				text: meta.name.length > 14 ? meta.name.slice(0, 11) + '...' : meta.name,
				textAlign: 'left',
				verticalAlign: 'top',
				baseline: 20,
			},
		])
		elements.push(...newElements)
		this.excalidrawApi.updateScene({ elements })
	}

}

/**
 * adds drop eventlistener to excalidraw
 * uploads file to nextcloud server, to be shared with all users
 * if filetype not supported by excalidraw inserts link to file
 * @param {ExcalidrawImperativeAPI} excalidrawApi excalidrawApi
 * @param collab {Collab} collab
 */
export function registerFilesHandler(
	excalidrawApi: ExcalidrawImperativeAPI,
	collab: Collab,
): FileHandle {
	const types = [
		'application/vnd.excalidraw+json',
		'application/vnd.excalidrawlib+json',
		'application/json',
		'image/svg+xml',
		'image/svg+xml',
		'image/png',
		'image/png',
		'image/jpeg',
		'image/gif',
		'image/webp',
		'image/bmp',
		'image/x-icon',
		'application/octet-stream',
	]
	return new FileHandle(excalidrawApi, collab, types)
}
