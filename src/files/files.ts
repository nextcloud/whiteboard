import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'

function addCustomFileElement(excalidrawApi: ExcalidrawImperativeAPI, link: string) {
	const elements = excalidrawApi.getSceneElementsIncludingDeleted().slice()
	const newElements = convertToExcalidrawElements([{
		text: link,
		type: 'text',
		fontSize: 16,
		textAlign: 'left',
		fontFamily: 1,
		x: 0,
		y: 0,
	}])
	elements.push(newElements[0])
	excalidrawApi.updateScene({ elements })
}

// TODO: Implement uploading to nextcloud
function UploadFileToNextcloud(file: File) {
	return file
}

function filesEventListener(ev: Event, excalidrawApi: ExcalidrawImperativeAPI) {
	if (ev instanceof DragEvent) {
		if (ev.dataTransfer?.files[0]) UploadFileToNextcloud(ev.dataTransfer?.files[0])
		const types = ['image/webp']
		if (!types.includes(ev.dataTransfer?.files[0].type || '')) {
			addCustomFileElement(excalidrawApi, ev.dataTransfer?.files[0].name || 'no file name')
			ev.stopImmediatePropagation()
		}
	}
}

/**
	* adds drop eventlistener to excalidraw
	* uploads file to nextcloud server, to be shared with all users
	* if filetype not supported by excalidraw inserts link to file
	* @param {ExcalidrawImperativeAPI} excalidrawApi excalidrawApi
*/
export function registerFilesHandler(excalidrawApi: ExcalidrawImperativeAPI) {
	const containerRef = document.getElementsByClassName('excalidraw-container')[0]
	if (containerRef) {
		containerRef.addEventListener('drop', (ev) => filesEventListener(ev, excalidrawApi))
	}
}
