/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ExcalidrawImperativeAPI, BinaryFileData, DataURL } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { FileId, ExcalidrawImageElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import { convertToExcalidrawElements } from '@nextcloud/excalidraw'

// Style constants - hardcoded values for static image rendering (CSS variables won't work in exported images)
const CELL_BASE_STYLE = 'border: 1px solid #ddd; padding: 12px 16px; line-height: 1.4; white-space: normal; word-wrap: break-word; overflow-wrap: break-word; word-break: break-word;'
const HEADER_CELL_STYLE = `${CELL_BASE_STYLE} background-color: #f5f5f5; font-weight: 600;`
const TABLE_STYLE = 'border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif; font-size: 14px;'

/**
 * Convert HTML table to an image element for Excalidraw
 * @param excalidrawAPI - The Excalidraw API instance
 * @param html - HTML content from Tiptap (source of truth)
 * @return The image element to be added to the canvas
 */
export async function convertHtmlTableToImage(
	excalidrawAPI: ExcalidrawImperativeAPI,
	html: string,
): Promise<ExcalidrawImageElement> {
	// Apply styles to the HTML table for image rendering
	const tableHtml = applyStylesToHtml(html)

	// Convert HTML to canvas/image
	const dataUrl = await htmlToDataUrl(tableHtml)

	// Get dimensions from the rendered content
	const { width, height } = await getImageDimensions(dataUrl)

	// Create file data for Excalidraw
	const fileId = generateFileId() as FileId
	const file: BinaryFileData = {
		mimeType: 'image/png',
		id: fileId,
		dataURL: dataUrl as DataURL,
		created: Date.now(),
	}

	// Add file to excalidraw
	excalidrawAPI.addFiles([file])

	// Create image element using convertToExcalidrawElements to ensure proper structure
	const elements = convertToExcalidrawElements([
		{
			type: 'image',
			fileId,
			x: 0,
			y: 0,
			width,
			height,
			// Store HTML as source of truth for re-editing
			customData: {
				tableHtml: html,
				isTable: true,
				tableLock: undefined,
			},
		},
	])

	return elements[0] as ExcalidrawImageElement
}

/**
 * Extract table from HTML and apply styles
 * @param html - Full HTML from Tiptap editor
 * @return Styled table HTML
 */
function applyStylesToHtml(html: string): string {
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, 'text/html')
	const table = doc.querySelector('table')

	if (!table) {
		throw new Error('No table found in HTML')
	}

	table.setAttribute('style', TABLE_STYLE)
	const headerCells = table.querySelectorAll('th')
	headerCells.forEach((cell) => {
		// Preserve text-align from style, otherwise use left
		const align = (cell as HTMLElement).style.textAlign || 'left'
		cell.setAttribute('style', HEADER_CELL_STYLE);
		(cell as HTMLElement).style.textAlign = align;
		// Set max-width to force text wrapping
		(cell as HTMLElement).style.maxWidth = '400px'
	})
	const bodyCells = table.querySelectorAll('td')
	bodyCells.forEach((cell) => {
		// Preserve text-align from style, otherwise use left
		const align = (cell as HTMLElement).style.textAlign || 'left'
		cell.setAttribute('style', CELL_BASE_STYLE);
		(cell as HTMLElement).style.textAlign = align;
		// Set max-width to force text wrapping
		(cell as HTMLElement).style.maxWidth = '400px'

		// Apply word-break to all nested elements (divs, paragraphs, etc.)
		const innerElements = cell.querySelectorAll('div, p, span')
		innerElements.forEach(el => {
			if (el instanceof HTMLElement) {
				el.style.wordWrap = 'break-word'
				el.style.overflowWrap = 'break-word'
				el.style.wordBreak = 'break-word'
				el.style.whiteSpace = 'normal'
			}
		})

		// Ensure empty paragraphs don't collapse
		const paragraphs = cell.querySelectorAll('p')
		paragraphs.forEach(p => {
			if (p instanceof HTMLElement) {
				p.style.minHeight = '1.4em'
				p.style.margin = '0'
			}
		})
	})

	return table.outerHTML
}

/**
 * Convert HTML to an SVG data URL
 * @param html - The HTML content to convert
 * @return SVG data URL of the rendered image
 */
async function htmlToDataUrl(html: string): Promise<string> {
	return new Promise((resolve) => {
		// Create a temporary off-screen container for measurement
		const container = document.createElement('div')
		container.innerHTML = html
		container.style.position = 'absolute'
		container.style.left = '-9999px'
		container.style.visibility = 'hidden'

		document.body.appendChild(container)

		// Wait for layout to complete
		requestAnimationFrame(() => {
			const svgDataUrl = createSvgDataUrl(container)
			document.body.removeChild(container)
			resolve(svgDataUrl)
		})
	})
}

/**
 * Create an SVG data URL with foreignObject containing the HTML
 * @param element - The HTML element to convert
 * @return SVG data URL
 */
function createSvgDataUrl(element: HTMLElement): string {
	// Get the table element directly for accurate measurements
	const table = element.querySelector('table') || element

	// Get bounding box of the entire table to capture all content
	const bbox = table.getBoundingClientRect()

	// Add padding to prevent border/content cutoff
	const padding = 4
	const width = Math.ceil(bbox.width) + (padding * 2)
	const height = Math.ceil(bbox.height) + (padding * 2)

	// Get the table HTML with all our style overrides applied
	let tableHtml = table.outerHTML
	tableHtml = tableHtml.replace(/<br>/g, '<br />')

	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
			<foreignObject x="0" y="0" width="${width}" height="${height}">
				<div xmlns="http://www.w3.org/1999/xhtml" style="background: white; padding: ${padding}px;">
					${tableHtml}
				</div>
			</foreignObject>
		</svg>
	`

	// Encode SVG to base64 - using TextEncoder for proper UTF-8 handling
	const bytes = new TextEncoder().encode(svg)
	const base64 = btoa(String.fromCharCode(...bytes))
	return 'data:image/svg+xml;base64,' + base64
}

/**
 * Get image dimensions from data URL
 * @param dataUrl - The data URL of the image
 * @return Object with width and height
 */
async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			resolve({ width: img.width, height: img.height })
		}
		img.onerror = reject
		img.src = dataUrl
	})
}

/**
 * Generate a unique file ID
 */
function generateFileId(): string {
	return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}
