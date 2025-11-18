/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module '@nextcloud/router' {
	export function generateUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string
	export function linkTo(app: string, file: string): string
}

declare module '@nextcloud/vue/dist/Components/NcRichText.js' {
	export function getLinkWithPicker(initialValue?: string | null, isLink?: boolean): Promise<string>
}
