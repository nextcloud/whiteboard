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
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/types/element/types'

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
		const constructedFile: BinaryFileData = {
			mimeType: 'image/png',
			created: 0o0,
			id: 'placeholder_image' as FileId,
			dataURL: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE0LDJMMjAsOFYyMEEyLDIgMCAwLDEgMTgsMjJINkEyLDIgMCAwLDEgNCwyMFY0QTIsMiAwIDAsMSA2LDJIMTRNMTgsMjBWOUgxM1Y0SDZWMjBIMThNMTIsMTlMOCwxNUgxMC41VjEySDEzLjVWMTVIMTZMMTIsMTlaIiAvPjwvc3ZnPg==' as DataURL,
		}
		this.collab.addFile(constructedFile)
		if (containerRef) {
			containerRef.addEventListener('drop', (ev) =>
				this.filesDragEventListener(ev),
			)
		}
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		this.excalidrawApi.onPointerDown((activeTool, state, event) => {
			const clickedElement = this.getElementAt(state.lastCoords.x, state.lastCoords.y)
			if (!clickedElement) {
				return
			}
			this.downloadFile(clickedElement.customData?.meta)
		})
	}

	private downloadFile(meta) {
		const blob = new Blob([meta.dataurl], { type: meta.type })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = meta.name
		a.click()
		URL.revokeObjectURL(url)
	}

	private getElementAt(px: number, py: number): ExcalidrawElement | undefined {
		const elements = this.excalidrawApi.getSceneElements()
		return elements.find((element) => {
			const { x, y, width, height } = element
			return (
				px >= x && px <= x + width
				&& py >= y && py <= y + height
			)
		})
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
				mimeType: 'image/png',
				created: 0o0,
				id: (Math.random() + 1).toString(36).substring(7) as FileId,
				dataURL: fr.result as DataURL,
			}
			const meta = {
				name: file.name, type: file.type, lastModified: file.lastModified, dataurl: fr.result,
			}
			this.addCustomFileElement(constructedFile, meta)
		}
	}

	private addCustomFileElement(constructedFile: BinaryFileData, meta) {
		this.collab.addFile(constructedFile)
		const elements = this.excalidrawApi
			.getSceneElementsIncludingDeleted()
			.slice()
		const newElements = convertToExcalidrawElements([
			{
				type: 'text',
				text: meta.name,
				customData: { meta },
				groupIds: ['1'],
				y: 0,
				x: 50,
			},
			{
				type: 'image',
				fileId: 'placeholder_image' as FileId,
				customData: { meta },
				groupIds: ['1'],
				y: -10,
				x: -10,
				width: 50,
				height: 50,
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
