/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { useCallback, useEffect, useRef } from 'react'
import {
	convertToExcalidrawElements,
	viewportCoordsToSceneCoords,
} from '@nextcloud/excalidraw'
import type {
	BinaryFileData,
	DataURL,
} from '@excalidraw/excalidraw/types/types'
import type { FileId } from '@excalidraw/excalidraw/types/element/types'
import axios from '@nextcloud/axios'
import { loadState } from '@nextcloud/initial-state'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useSidebarDownload } from './useSidebarDownload'

export type Meta = {
	name: string
	type: string
	lastModified: number
	fileId: string
	dataURL: string
}

export interface FileHandlerInterface {
	addFile: (file: BinaryFileData) => void
	sendImageFiles: (files: Record<string, BinaryFileData>) => void
}

export function useFiles(
	sendImageFiles: (files: Record<string, BinaryFileData>) => Promise<void>,
) {
	const { excalidrawAPI } = useExcalidrawStore()
	const filesRef = useRef(new Map<string, BinaryFileData>())

	const downloadFile = useCallback((meta: Meta) => {
		const url = meta.dataURL
		const a = document.createElement('a')
		a.href = url
		a.download = meta.name
		a.click()
	}, [])

	const {
		activeMeta,
		showDownloadButton,
		hideDownloadButton,
		handleDownload,
	} = useSidebarDownload(downloadFile)

	const supportedTypes = [
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

	const addFile = useCallback(
		(file: BinaryFileData) => {
			if (!excalidrawAPI) return

			// Check if we already have this file with the same content
			const existingFile = filesRef.current.get(file.id)
			if (existingFile) {
				// If the file exists and has the same dataURL, skip adding it again
				// This prevents unnecessary re-renders
				if (existingFile.dataURL === file.dataURL) {
					// Skip adding file with same content to prevent blinking
					return
				}
				// File exists but content changed, updating
			}

			// Store in our ref
			filesRef.current.set(file.id, file)

			// Check if the file is already in Excalidraw's files
			const excalidrawFiles = excalidrawAPI.getFiles()
			if (excalidrawFiles[file.id]) {
				// If the file exists in Excalidraw but content changed, we need to update it
				// For now, we'll just add it again and let Excalidraw handle the update
			}

			// Add to Excalidraw
			excalidrawAPI.addFiles([file])
		},
		[excalidrawAPI],
	)

	const handleFilesDragEvent = useCallback(
		(ev: DragEvent) => {
			if (!excalidrawAPI || !(ev instanceof DragEvent)) return

			for (const file of Array.from(ev.dataTransfer?.files || [])) {
				handleFileInsert(file, ev)
			}
		},
		[excalidrawAPI],
	)

	const handleFileInsert = useCallback(
		(file: File, ev: Event) => {
			if (!excalidrawAPI) return

			const maxFileSize = loadState('whiteboard', 'maxFileSize', 10)
			if (file.size > maxFileSize * 1024 * 1024) {
				ev.stopImmediatePropagation()
				excalidrawAPI.setToast({
					message: `Max image size is ${maxFileSize} MB`,
					closable: true,
					duration: 5000,
				})
				return
			}

			// if excalidraw can handle it, do nothing
			if (supportedTypes.includes(file.type)) {
				return
			}
			ev.stopImmediatePropagation()

			const fr = new FileReader()
			fr.readAsDataURL(file)
			fr.onload = () => {
				if (typeof fr.result !== 'string') return

				const constructedFile: BinaryFileData = {
					mimeType: file.type,
					created: Date.now(),
					id: (Math.random() + 1).toString(36).substring(7) as FileId,
					dataURL: fr.result as DataURL,
				}

				const meta: Meta = {
					name: file.name,
					type: file.type,
					lastModified: file.lastModified,
					fileId: constructedFile.id,
					dataURL: fr.result,
				}

				addCustomFileElement(constructedFile, meta, ev.x, ev.y)
			}
		},
		[excalidrawAPI],
	)

	const getMimeIcon = useCallback(
		async (mimeType: string): Promise<FileId> => {
			if (!excalidrawAPI) throw new Error('Excalidraw API not available')

			let file = excalidrawAPI.getFiles()[`filetype-icon-${mimeType}`]
			if (!file) {
				const iconUrl = window.OC.MimeType.getIconUrl(mimeType)
				const response = await axios.get(iconUrl, {
					responseType: 'arraybuffer',
				})
				const blob = new Blob([response.data], {
					type: 'image/svg+xml',
				})

				return new Promise((resolve) => {
					const reader = new FileReader()
					reader.onloadend = () => {
						if (typeof reader.result === 'string') {
							file = {
								mimeType: blob.type,
								id: `filetype-icon-${mimeType}` as FileId,
								dataURL: reader.result as DataURL,
							}
							sendImageFiles({ [file.id]: file }).then(() => {
								resolve(file.id)
							})
						}
					}
					reader.readAsDataURL(blob)
				})
			}
			return file.id
		},
		[excalidrawAPI, sendImageFiles],
	)

	const addCustomFileElement = useCallback(
		async (
			constructedFile: BinaryFileData,
			meta: Meta,
			clientX: number,
			clientY: number,
		) => {
			if (!excalidrawAPI) return

			const { x, y } = viewportCoordsToSceneCoords(
				{ clientX, clientY },
				excalidrawAPI.getAppState(),
			)
			const iconId = await getMimeIcon(meta.type)
			const elements = excalidrawAPI
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
					x,
					y,
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
					x: x + 28.8678679811,
					y: y + 16.3505845419,
					width: 1,
					height: 1,
					opacity: 0,
					locked: true,
					groupIds: [meta.fileId],
				},
				{
					type: 'image',
					fileId: iconId,
					x: x + 28.8678679811,
					y: y + 16.3505845419,
					width: 48.880073102719564,
					height: 48.880073102719564,
					locked: true,
					groupIds: [meta.fileId],
				},
				{
					type: 'text',
					isDeleted: false,
					fillStyle: 'solid',
					strokeWidth: 1,
					strokeStyle: 'solid',
					opacity: 100,
					x: x + 85.2856430662,
					y: y + 28.8678679811,
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
					text:
						meta.name.length > 14
							? meta.name.slice(0, 11) + '...'
							: meta.name,
					textAlign: 'left',
					verticalAlign: 'top',
					baseline: 20,
				},
			])
			elements.push(...newElements)
			excalidrawAPI.updateScene({ elements })
		},
		[excalidrawAPI, getMimeIcon],
	)

	useEffect(() => {
		if (!excalidrawAPI) return

		// Set up drag event listener
		const containerRef = document.getElementsByClassName(
			'excalidraw-container',
		)[0]
		if (containerRef) {
			containerRef.addEventListener('drop', handleFilesDragEvent)
		}

		// Set up pointer down handler for file download
		const pointerDownHandler = async (_activeTool, state) => {
			// Always hide any existing download button first
			hideDownloadButton()

			const clickedElement = state.hit.element
			if (!clickedElement || !clickedElement.customData) {
				return
			}

			// Show download button for this meta
			showDownloadButton(clickedElement.customData.meta)
		}

		excalidrawAPI.onPointerDown(pointerDownHandler)

		return () => {
			// Clean up event listeners
			if (containerRef) {
				containerRef.removeEventListener('drop', handleFilesDragEvent)
			}

			// Hide any download button on cleanup
			hideDownloadButton()
		}
	}, [
		excalidrawAPI,
		handleFilesDragEvent,
		showDownloadButton,
		hideDownloadButton,
	])

	return {
		addFile,
		downloadFile,
		getMimeIcon,
		addCustomFileElement,
		activeMeta,
		handleDownload,
	}
}
