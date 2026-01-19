/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module '@nextcloud/router' {
	export function generateUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string
	export function linkTo(app: string, file: string): string
	export function imagePath(app:string, file: string): string
}

declare module '@nextcloud/vue/dist/Components/NcRichText.js' {
	export function getLinkWithPicker(initialValue?: string | null, isLink?: boolean): Promise<string>
}

// Extend window.OCA type to include Text app API
interface Window {
	OCA?: {
		Viewer?: {
			compareFileInfo?: unknown
		}
		Text?: {
			createTable: (options: {
				el: HTMLElement
				content: string
				readOnly?: boolean
				onUpdate?: (data: { markdown: string }) => void
			}) => Promise<{
				destroy: () => void
				getHTML: () => string
				focus?: () => void
			}>
		}
	}
}
