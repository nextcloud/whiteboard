/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type {
	BinaryFileData,
	DataURL,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types/types'
import { Collab } from '../collaboration/collab'
import type { FileId } from '@excalidraw/excalidraw/types/element/types'
import axios from '@nextcloud/axios'

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
	constructor(
		excalidrawApi: ExcalidrawImperativeAPI,
		collab: Collab,
		types: string[],
	) {
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
		let lastPointerDown = 0
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		this.excalidrawApi.onPointerDown((activeTool, state, event) => {
			const clickedElement = state.hit.element
			if (!clickedElement || !clickedElement.customData) {
				return
			}
			event.stopPropagation()
			if (Date.now() - lastPointerDown > 200) {
				lastPointerDown = Date.now()
				return
			} else {
				lastPointerDown = Date.now()
			}
			this.downloadFile(clickedElement.customData.meta)
		})
	}

	private downloadFile(meta: Meta) {
		const file = this.excalidrawApi.getFiles()[meta.fileId]
		const blob = new Blob([file.dataURL], { type: meta.type })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = meta.name
		a.click()
		URL.revokeObjectURL(url)
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
			const iconUrl = window.OC.MimeType.getIconUrl(mimeType);
			let response = await axios.get(iconUrl, { responseType: 'arraybuffer' })
			const blob = new Blob([response.data], { type:'image/svg+xml' })

			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => {
					if (typeof reader.result === "string") {
						file = {
							mimeType: blob.type,
							id: `filetype-icon-${mimeType}` as FileId,
							dataURL: reader.result as DataURL
						}
						this.collab.portal.sendImageFiles({[file.id]: file})
						resolve(file.id)
					}
					console.log(`doing it ${reader.result} ${typeof reader.result}`)
				}
				reader.readAsDataURL(blob);
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
				width: 260.62770075583379,
				height: 81.57857850076135,
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
				width: 0,
				height: 0,
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
