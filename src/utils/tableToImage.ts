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
const CODE_STYLE = 'background-color: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em;'
const LINK_STYLE = 'color: #00679e; text-decoration: none;'

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
	const headerCells = lines[0].split('|').filter(cell => cell.trim())
	html += '<thead><tr>'
	headerCells.forEach(cell => {
		html += `<th style="${HEADER_CELL_STYLE}">${parseInlineMarkdown(cell.trim())}</th>`
	})
	html += '</tr></thead>'

	// Skip separator line (index 1)
	// Parse body rows
	html += '<tbody>'
	for (let i = 2; i < lines.length; i++) {
		const cells = lines[i].split('|').filter(cell => cell.trim())
		if (cells.length > 0) {
			html += '<tr>'
			cells.forEach(cell => {
				html += `<td style="${CELL_BASE_STYLE}">${parseInlineMarkdown(cell.trim())}</td>`
			})
			html += '</tr>'
		}
	}
	html += '</tbody></table>'

	return html
}

/**
 * Parse inline markdown formatting (bold, italic, code, strikethrough, etc.)
 * @param text - The text to parse
 * @return HTML string with inline formatting
 */
function parseInlineMarkdown(text: string): string {
	let result = text

	// Escape HTML special characters first (except & which might be part of existing entities)
	result = result
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')

	// Bold with ** or __
	result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
	result = result.replace(/__(.+?)__/g, '<strong>$1</strong>')

	// Italic with * or _
	result = result.replace(/\*(.+?)\*/g, '<em>$1</em>')
	result = result.replace(/_(.+?)_/g, '<em>$1</em>')

	// Strikethrough with ~~
	result = result.replace(/~~(.+?)~~/g, '<del>$1</del>')

	// Inline code with `
	result = result.replace(/`(.+?)`/g, `<code style="${CODE_STYLE}">$1</code>`)

	// Links [text](url)
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" style="${LINK_STYLE}">$1</a>`)

	return result
}

/**
 * Convert HTML to a data URL using canvas rendering
 * @param html - The HTML content to convert
 * @return Data URL of the rendered image
 */
async function htmlToDataUrl(html: string): Promise<string> {
	return new Promise((resolve, reject) => {
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
			const cleanup = () => document.body.removeChild(container)
			try {
				// Use html2canvas if available, otherwise use a simple SVG approach
				if (typeof window.html2canvas === 'function') {
					window.html2canvas(container).then(canvas => {
						const dataUrl = canvas.toDataURL('image/png')
						cleanup()
						resolve(dataUrl)
					}).catch(error => {
						cleanup()
						reject(error)
					})
				} else {
					// Fallback: create SVG with foreignObject
					const svgDataUrl = createSvgDataUrl(container)
					cleanup()
					resolve(svgDataUrl)
				}
			} catch (error) {
				cleanup()
				reject(error)
			}
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

declare global {
	interface Window {
		html2canvas?: (element: HTMLElement) => Promise<HTMLCanvasElement>
	}
}
