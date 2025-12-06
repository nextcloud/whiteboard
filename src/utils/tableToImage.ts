/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ExcalidrawImperativeAPI, BinaryFileData, DataURL } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { FileId, ExcalidrawImageElement } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import { convertToExcalidrawElements } from '@nextcloud/excalidraw'

// Style constants - hardcoded values for static image rendering (CSS variables won't work in exported images)
const CELL_BASE_STYLE = 'border: 1px solid #ddd; padding: 12px 16px;'
const HEADER_CELL_STYLE = `${CELL_BASE_STYLE} background-color: #f5f5f5; font-weight: 600; text-align: left;`
const TABLE_STYLE = 'border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif; font-size: 14px;'

/**
 * Convert markdown table to an image element for Excalidraw
 * @param markdown - The markdown table content
 * @param excalidrawAPI - The Excalidraw API instance
 * @return The image element to be added to the canvas
 */
export async function convertMarkdownTableToImage(
	markdown: string,
	excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<ExcalidrawImageElement> {
	// Render the markdown table to HTML
	const html = await renderMarkdownToHtml(markdown)

	// Convert HTML to canvas/image
	const dataUrl = await htmlToDataUrl(html)

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
			// Store original markdown for re-editing
			customData: {
				tableMarkdown: markdown,
				isTable: true,
				tableLock: undefined,
			},
		},
	])

	return elements[0] as ExcalidrawImageElement
}

/**
 * Render markdown to HTML using a simple markdown parser
 * @param markdown - The markdown table content
 * @return HTML string
 */
async function renderMarkdownToHtml(markdown: string): Promise<string> {
	// Parse markdown table to HTML
	const lines = markdown.trim().split('\n')
	if (lines.length < 2) {
		throw new Error('Invalid table format')
	}

	let html = `<table style="${TABLE_STYLE}">`

	// Parse header
	const headerCells = lines[0].split('|').slice(1, -1) // Remove first and last empty strings from pipes to allow empty cells
	html += '<thead><tr>'
	headerCells.forEach(cell => {
		html += `<th style="${HEADER_CELL_STYLE}">${escapeHtml(cell.trim())}</th>`
	})
	html += '</tr></thead>'

	// Skip separator line (index 1)
	// Parse body rows
	html += '<tbody>'
	for (let i = 2; i < lines.length; i++) {
		const line = lines[i].trim()
		if (!line) continue // Skip empty lines

		// Check if line looks like a table row (starts and ends with |)
		if (line.startsWith('|') && line.endsWith('|')) {
			// Standard table row - split by pipes
			const cells = line.split('|').slice(1, -1) // Remove first and last empty strings from pipes to allow empty cells
			if (cells.length > 0) {
				html += '<tr>'
				cells.forEach(cell => {
					html += `<td style="${CELL_BASE_STYLE}">${escapeHtml(cell.trim())}</td>`
				})
				html += '</tr>'
			}
		} else {
			// Non-table line - split by | to create cells
			const cells = line.split('|')
			html += '<tr>'
			cells.forEach(cell => {
				const trimmed = cell.trim()
				if (trimmed) { // Only create cell if not empty
					html += `<td style="${CELL_BASE_STYLE}">${escapeHtml(trimmed)}</td>`
				}
			})
			html += '</tr>'
		}
	}
	html += '</tbody></table>'

	return html
}

/**
 * Escape HTML special characters to prevent XSS
 * @param text - The text to escape
 * @return Escaped HTML string
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Convert HTML to an SVG data URL
 * @param html - The HTML content to convert
 * @return SVG data URL of the rendered image
 */
async function htmlToDataUrl(html: string): Promise<string> {
	return new Promise((resolve) => {
		// Create a temporary container
		const container = document.createElement('div')
		container.innerHTML = html
		container.style.position = 'absolute'
		container.style.left = '-9999px'
		container.style.top = '-9999px'
		container.style.padding = '16px'
		container.style.backgroundColor = 'white'
		document.body.appendChild(container)

		// Wait for next frame to ensure rendering
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
	const bbox = element.getBoundingClientRect()
	const width = Math.max(bbox.width, 400)
	const height = Math.max(bbox.height, 200)

	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
			<foreignObject width="100%" height="100%">
				<div xmlns="http://www.w3.org/1999/xhtml" style="padding: 16px; background: white;">
					${element.innerHTML}
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
