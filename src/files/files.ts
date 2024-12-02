import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type {
	BinaryFileData,
	DataURL,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types/types'
import { Collab } from '../collaboration/collab'
import type { FileId } from '@excalidraw/excalidraw/types/element/types'

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
		let constructedFile: BinaryFileData = {
			mimeType: 'image/png',
			created: 0o0,
			id: 'placeholder_image' as FileId,
			dataURL: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE0LDJMMjAsOFYyMEEyLDIgMCAwLDEgMTgsMjJINkEyLDIgMCAwLDEgNCwyMFY0QTIsMiAwIDAsMSA2LDJIMTRNMTgsMjBWOUgxM1Y0SDZWMjBIMThNMTIsMTlMOCwxNUgxMC41VjEySDEzLjVWMTVIMTZMMTIsMTlaIiAvPjwvc3ZnPg==' as DataURL,
		}
		this.collab.addFile(constructedFile)
		if (containerRef) {
			containerRef.addEventListener('drop', (ev) =>
				this.filesDragEventListener(ev, excalidrawApi),
			)
		}
		this.excalidrawApi.onPointerDown((tool, state, event) => {
		})
	}

	private filesDragEventListener(ev: Event, excalidrawApi: ExcalidrawImperativeAPI) {
		if (ev instanceof DragEvent) {
			for (let file of Array.from(ev.dataTransfer?.files || [])) {
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
			let constructedFile: BinaryFileData = {
				mimeType: 'image/png',
				created: 0o0,
				id: (Math.random() + 1).toString(36).substring(7) as FileId,
				dataURL: fr.result as DataURL,
			}
			this.addCustomFileElement(constructedFile, file.name)
		}
	}

	private addCustomFileElement(constructedFile: BinaryFileData, filename: string) {
		this.collab.addFile(constructedFile)
		const elements = this.excalidrawApi
			.getSceneElementsIncludingDeleted()
			.slice()
		const newElements = convertToExcalidrawElements([
			{
				type: 'text',
				text: filename,
				customData: { filedata: { constructedFile } },
				groupIds: ['1'],
				y: 0,
				x: 0,
			},
			{
				type: 'image',
				fileId: 'placeholder_image' as FileId,
				groupIds: ['1'],
				y: 0,
				x: 0,
			}
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
