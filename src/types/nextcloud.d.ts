/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module '@nextcloud/router' {
	export function generateUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string
	export function linkTo(app: string, file: string): string
	export function imagePath(app:string, file: string): string
}

declare module '@nextcloud/dialogs' {
	export function showError(text: string, options?: Record<string, unknown>): void
	export function showSuccess(text: string, options?: Record<string, unknown>): void
}

declare module '@nextcloud/sharing/public' {
	export function getSharingToken(): string | null
	export function isPublicShare(): boolean
}

declare module '*.vue' {
	import type { Component } from 'vue'

	const component: Component
	export default component
}

declare module '@nextcloud/vue/components/NcRichText' {
	import type { Component } from 'vue'

	export const NcReferenceList: Component
	export function getLinkWithPicker(providerId?: string, isInsideViewer?: boolean): Promise<string>
}

declare module '@nextcloud/vue/functions/dialog' {
	import type { Component } from 'vue'

	export function spawnDialog(component: Component, props?: Record<string, unknown>): Promise<unknown>
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
