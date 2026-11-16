/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { WhiteboardRootHandle } from '../utils/renderWhiteboardView.tsx'

import { h } from 'vue'
import { keepCtrlDelete } from '../utils/keepCtrlDelete.ts'
import { matchesComparisonRequest, renderWhiteboardView } from '../utils/renderWhiteboardView.tsx'
import { isStoredCopy } from '../utils/versionRestore.ts'

export type ViewerComponentOptions = {
	collabBackendUrl: string
	resolveSharingToken: () => string | null
}

type WhiteboardComponentData = {
	containerId: string
	root: WhiteboardRootHandle | null
	releaseCtrlDelete: (() => void) | null
}

type LegacyCreateElement = (
	tag: string,
	data?: Record<string, unknown>,
	children?: string,
) => unknown

type WhiteboardComponentInstance = WhiteboardComponentData & {
	$el?: Element
	$emit: (event: string, ...args: unknown[]) => void
	$nextTick: (callback: () => void) => void
	fileid?: number | null
	fileId?: number | null
	fileVersion?: string | null
	source?: string | null
	isEmbedded?: boolean
	isComparisonView?: boolean
	active?: boolean
	basename?: string
}

export type ViewerComponentDefinition = {
	name: string
	render(this: WhiteboardComponentInstance, createElement?: LegacyCreateElement): unknown
	mounted(this: WhiteboardComponentInstance): void
	beforeDestroy(this: WhiteboardComponentInstance): void
	beforeUnmount(this: WhiteboardComponentInstance): void
	watch: Record<string, (this: WhiteboardComponentInstance) => void>
	props: Record<string, unknown>
	data: () => WhiteboardComponentData
}

function unmountWhiteboardRoot(component: WhiteboardComponentInstance): void {
	component.releaseCtrlDelete?.()
	component.releaseCtrlDelete = null
	component.root?.unmount()
	component.root = null
}

/**
 * Whether the board is the file the user sees. The viewer also renders the
 * previous and next file, hidden and without `active`: those must not open
 * their boards, which would save and show content through the shown one.
 *
 * @param component
 */
function isShown(component: WhiteboardComponentInstance): boolean {
	return component.active === true || !component.$el?.closest?.('.viewer__file-wrapper--hidden')
}

/**
 * Opens the board once the board that was shown before has closed: boards
 * share the page's stores, so the closing one must not clear what the new
 * one set.
 *
 * @param component
 * @param options
 */
function mountLater(component: WhiteboardComponentInstance, options: ViewerComponentOptions): void {
	setTimeout(() => {
		if (isShown(component) && !component.root && component.$el?.isConnected) {
			mountWhiteboardApp(component, options)
		}
	})
}

function mountWhiteboardApp(component: WhiteboardComponentInstance, options: ViewerComponentOptions): void {
	const rootElement = (component.$el ?? document.getElementById(component.containerId)) as HTMLElement | null
	if (!rootElement) {
		return
	}
	const normalizedFileId
		= Number(component.fileid ?? component.fileId ?? 0) || 0
	const isComparisonView = Boolean(component.isComparisonView)
	const isEmbedded = Boolean(component.isEmbedded)
	const rawVersionSource = component.source ?? null
	const rawFileVersion = component.fileVersion ?? null
	const isVersionsDavSource = rawVersionSource !== null && isStoredCopy(rawVersionSource)
	const shouldUseVersionPreview
		= isComparisonView
			|| (rawFileVersion !== null && isVersionsDavSource)
			|| matchesComparisonRequest(
				rawVersionSource,
				rawFileVersion ?? null,
			)
	const showsVersion = isEmbedded || shouldUseVersionPreview
	const versionSource = showsVersion ? rawVersionSource : null
	const fileVersion = showsVersion ? rawFileVersion : null
	const fileName
		= typeof component.basename === 'string' ? component.basename : ''

	component.root = renderWhiteboardView(rootElement, {
		fileId: normalizedFileId,
		isEmbedded,
		fileName,
		publicSharingToken: options.resolveSharingToken(),
		collabBackendUrl: options.collabBackendUrl,
		versionSource,
		fileVersion,
		isComparisonView,
	})
}

export function createWhiteboardComponent(options: ViewerComponentOptions): ViewerComponentDefinition {
	return {
		name: 'Whiteboard',
		render(
			this: WhiteboardComponentInstance,
			createElement?: LegacyCreateElement,
		): unknown {
			const isVue2Render = typeof createElement === 'function'
			const renderElement = isVue2Render ? createElement : h
			const attrs = isVue2Render
				? { attrs: { id: this.containerId } }
				: { id: this.containerId }

			return renderElement(
				'div',
				{
					...attrs,
					class: [
						'whiteboard',
						{
							'whiteboard-viewer__embedding': Boolean(this.isEmbedded),
						},
					],
				},
				'',
			)
		},
		mounted(this: WhiteboardComponentInstance) {
			this.$emit('update:loaded', true)

			const rootElement = (this.$el ?? document.getElementById(this.containerId)) as HTMLElement | null
			if (!rootElement) {
				return
			}

			rootElement.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') {
					event.stopPropagation()
				}
			})
			this.releaseCtrlDelete = keepCtrlDelete(() => this.active === true)

			if (isShown(this)) {
				mountLater(this, options)
			}
		},
		watch: {
			// The viewer moves a hidden neighbour into view, and the shown file out of it; checked once the page shows the move
			active(this: WhiteboardComponentInstance) {
				this.$nextTick(() => {
					if (isShown(this) && !this.root) {
						mountLater(this, options)
					} else if (!isShown(this) && this.root) {
						this.root.unmount()
						this.root = null
					}
				})
			},
		},
		beforeDestroy(this: WhiteboardComponentInstance) {
			unmountWhiteboardRoot(this)
		},
		beforeUnmount(this: WhiteboardComponentInstance) {
			unmountWhiteboardRoot(this)
		},
		props: {
			filename: { type: String, default: null },
			fileid: { type: Number, default: null },
			fileId: { type: Number, default: null },
			fileVersion: { type: String, default: null },
			source: { type: String, default: null },
			isEmbedded: { type: Boolean, default: false },
			isComparisonView: { type: Boolean, default: false },
			// The viewer also renders the previous and next file, without `active`
			active: { type: Boolean, default: false },
		},
		data: (): WhiteboardComponentData => ({
			containerId: generateWhiteboardElementId(),
			root: null,
			releaseCtrlDelete: null,
		}),
	}
}

export function generateWhiteboardElementId() {
	return `whiteboard-${Math.random()
		.toString(36)
		.replace(/[^a-z]+/g, '')
		.substr(2, 10)}`
}
