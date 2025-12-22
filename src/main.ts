/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type Vue from 'vue'
import type { ComponentOptions, CreateElement, VNode } from 'vue'

import { loadState } from '@nextcloud/initial-state'
import { linkTo } from '@nextcloud/router'
import { getSharingToken, isPublicShare } from '@nextcloud/sharing/public'

import './styles/index.scss'
import logger from './utils/logger'
import {
	matchesComparisonRequest,
	renderWhiteboardView,
} from './utils/renderWhiteboardView'
import type { WhiteboardRootHandle } from './utils/renderWhiteboardView'

declare global {
	interface Window {
		EXCALIDRAW_ASSET_PATH?: string | string[]
	}
}

window.EXCALIDRAW_ASSET_PATH = linkTo('whiteboard', 'dist/')

type RecordingContext = {
	fileId: number
	collabBackendUrl: string
	jwt: string
}

type PublicShareContext = {
	fileId: number
	collabBackendUrl: string
	sharingToken: string | null
}

type ViewerContext = {
	collabBackendUrl: string
	resolveSharingToken: () => string | null
}

type RuntimeDescriptor =
	| { type: 'recording'; context: RecordingContext }
	| { type: 'public-share'; context: PublicShareContext }
	| { type: 'viewer'; context: ViewerContext }

const VIEWER_REGISTRATION_ATTEMPTS = 3
const VIEWER_REGISTRATION_DELAY_MS = 250

const bootstrapWhiteboardRuntime = (): void => {
	const runtime = detectRuntime()

	switch (runtime.type) {
	case 'recording':
		runRecordingRuntime(runtime.context)
		return
	case 'public-share':
		runPublicShareRuntime(runtime.context)
		return
	case 'viewer':
	default:
		runDefaultViewerRuntime(runtime.context)
	}
}

const detectRuntime = (): RuntimeDescriptor => {
	const fileId = normalizeNumericState(
		loadState('whiteboard', 'file_id', '0'),
	)
	const collabBackendUrl = loadState('whiteboard', 'collabBackendUrl', '')

	if (loadState('whiteboard', 'isRecording', false)) {
		return {
			type: 'recording',
			context: {
				fileId,
				collabBackendUrl,
				jwt: loadState('whiteboard', 'jwt', ''),
			},
		}
	}

	if (isPublicShare()) {
		return {
			type: 'public-share',
			context: {
				fileId,
				collabBackendUrl,
				sharingToken: getSharingToken(),
			},
		}
	}

	return {
		type: 'viewer',
		context: {
			collabBackendUrl,
			resolveSharingToken: () => getSharingToken(),
		},
	}
}

function runRecordingRuntime(context: RecordingContext): void {
	runWhenDomReady(async () => {
		await primeRecordingJwt(context.fileId, context.jwt)

		document.body.removeAttribute('id')
		document.body.innerHTML = ''
		const whiteboardElement = createWhiteboardElement()
		whiteboardElement.classList.add('recording')
		document.body.appendChild(whiteboardElement)

		renderWhiteboardView(whiteboardElement, {
			fileId: context.fileId,
			isEmbedded: false,
			fileName: '',
			publicSharingToken: null,
			collabBackendUrl: context.collabBackendUrl,
			versionSource: null,
			fileVersion: null,
		})
	})
}

function runPublicShareRuntime(context: PublicShareContext): void {
	document.body.classList.add('whiteboard-public-share')

	// On NC29/30, there's a hidden input with id="mimetype" that we can check.
	// On NC31+, this element doesn't exist. Since this script is only loaded
	// for whiteboard files (via BeforeTemplateRenderedListener), we can safely
	// skip this check if the element doesn't exist.
	const mimetypeElmt = document.getElementById('mimetype') as HTMLInputElement | null
	if (mimetypeElmt && mimetypeElmt.value !== 'application/vnd.excalidraw+json') {
		return
	}

	const viewerContext: ViewerContext = {
		collabBackendUrl: context.collabBackendUrl,
		resolveSharingToken: () => context.sharingToken,
	}

	let hasOpenedInViewer = false
	const openInViewer = (): void => {
		if (hasOpenedInViewer) {
			return
		}

		const viewerApi = getViewerApi()
		if (!viewerApi) {
			return
		}

		if (typeof viewerApi.openWith !== 'function' && typeof viewerApi.open !== 'function') {
			return
		}

		hasOpenedInViewer = true

		try {
			viewerApi.setRootElement?.(null)
		} catch {
			// ignore
		}

		try {
			if (typeof viewerApi.openWith === 'function') {
				viewerApi.openWith('whiteboard', { path: '/', enableSidebar: false, canLoop: false })
				return
			}

			viewerApi.open?.({ path: '/', enableSidebar: false, canLoop: false })
		} catch (error) {
			hasOpenedInViewer = false
			logger.error('Could not open public share in viewer', { error })
		}
	}

	const openEmbeddedFallback = (): void => {
		if (hasOpenedInViewer) {
			return
		}

		const previewHost = document.getElementById('preview') || document.getElementById('imgframe')
		if (!previewHost) {
			return
		}

		previewHost.innerHTML = ''

		const whiteboardElement = createWhiteboardElement()
		previewHost.appendChild(whiteboardElement)

		renderWhiteboardView(whiteboardElement, {
			fileId: context.fileId,
			isEmbedded: false,
			fileName: document.title,
			publicSharingToken: context.sharingToken,
			collabBackendUrl: context.collabBackendUrl,
			versionSource: null,
			fileVersion: null,
		})
	}

	runWhenDomReady(() => {
		registerViewerHandler(createWhiteboardComponent(viewerContext), 0, openInViewer)

		window.setTimeout(() => {
			openEmbeddedFallback()
		}, 2500)
	})
}

function runDefaultViewerRuntime(context: ViewerContext): void {
	runWhenDomReady(() => {
		registerViewerHandler(createWhiteboardComponent(context))
	})
}

type ViewerComponentOptions = {
	collabBackendUrl: string
	resolveSharingToken: () => string | null
}

type WhiteboardComponentData = { root: WhiteboardRootHandle | null }

type WhiteboardComponentInstance = Vue &
	WhiteboardComponentData & {
		fileid?: number | null
		fileId?: number | null
		fileVersion?: string | null
		source?: string | null
		isEmbedded?: boolean
		isComparisonView?: boolean
		basename?: string
	}

type VueComponentDefinition = ComponentOptions<WhiteboardComponentInstance> & {
	data: () => WhiteboardComponentData
}

type ViewerHandlerRegistration = {
	id: string
	mimes: string[]
	component: VueComponentDefinition
	group: string | null
	theme: string
	canCompare: boolean
}

type ViewerApi = {
	registerHandler?: (handler: ViewerHandlerRegistration) => void
	open?: (options?: {
		path?: string
		fileInfo?: unknown
		list?: unknown[]
		enableSidebar?: boolean
		loadMore?: () => unknown[]
		canLoop?: boolean
		onPrev?: () => void
		onNext?: () => void
		onClose?: () => void
	}) => void
	openWith?: (handlerId: string, options?: {
		path?: string
		fileInfo?: unknown
		list?: unknown[]
		enableSidebar?: boolean
		loadMore?: () => unknown[]
		canLoop?: boolean
		onPrev?: () => void
		onNext?: () => void
		onClose?: () => void
	}) => void
	setRootElement?: (el?: string | null) => void
	compareFileInfo?: unknown
}

type WindowWithViewer = Window & {
	OCA?: {
		Viewer?: ViewerApi
	}
}

const createWhiteboardComponent = (
	options: ViewerComponentOptions,
): VueComponentDefinition => ({
	name: 'Whiteboard',
	render(
		this: WhiteboardComponentInstance,
		createElement: CreateElement,
	): VNode {
		this.$emit('update:loaded', true)
		const containerId = generateWhiteboardElementId()

		this.$nextTick(() => {
			const rootElement = document.getElementById(containerId)
			if (!rootElement) {
				return
			}

			rootElement.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') {
					event.stopPropagation()
				}
			})

			const normalizedFileId
				= Number(this.fileid ?? this.fileId ?? 0) || 0
			const isComparisonView = Boolean(this.isComparisonView)
			const isEmbedded = Boolean(this.isEmbedded)
			const rawVersionSource = this.source ?? null
			const rawFileVersion = this.fileVersion ?? null
			const isVersionsDavSource
				= rawVersionSource?.includes('/dav/versions/')
				|| rawVersionSource?.includes('/dav/trashbin/')
				|| false
			const shouldUseVersionPreview
				= isComparisonView
				|| (rawFileVersion !== null && isVersionsDavSource)
				|| matchesComparisonRequest(
					rawVersionSource,
					rawFileVersion ?? null,
				)
			const versionSource = isEmbedded
				? rawVersionSource
				: shouldUseVersionPreview
					? rawVersionSource
					: null
			const fileVersion = isEmbedded
				? rawFileVersion
				: shouldUseVersionPreview
					? rawFileVersion
					: null
			const fileName
				= typeof this.basename === 'string' ? this.basename : ''

			this.root = renderWhiteboardView(rootElement, {
				fileId: normalizedFileId,
				isEmbedded,
				fileName,
				publicSharingToken: options.resolveSharingToken(),
				collabBackendUrl: options.collabBackendUrl,
				versionSource,
				fileVersion,
				isComparisonView,
			})
		})

		return createElement(
			'div',
			{
				attrs: { id: containerId },
				class: [
					'whiteboard',
					{
						'whiteboard-viewer__embedding': Boolean(
							this.isEmbedded,
						),
					},
				],
			},
			'',
		)
	},
	beforeDestroy(this: WhiteboardComponentInstance) {
		this.root?.unmount()
	},
	props: {
		filename: { type: String, default: null },
		fileid: { type: Number, default: null },
		fileId: { type: Number, default: null },
		fileVersion: { type: String, default: null },
		source: { type: String, default: null },
		isEmbedded: { type: Boolean, default: false },
		isComparisonView: { type: Boolean, default: false },
	},
	data: (): WhiteboardComponentData => ({ root: null }),
})

const registerViewerHandler = (
	component: VueComponentDefinition,
	attempt = 0,
	afterRegister?: () => void,
): void => {
	const viewerApi = getViewerApi()

	if (viewerApi?.registerHandler) {
		viewerApi.registerHandler({
			id: 'whiteboard',
			mimes: ['application/vnd.excalidraw+json'],
			component,
			group: null,
			theme: 'default',
			canCompare: true,
		})
		afterRegister?.()
		return
	}

	if (attempt >= VIEWER_REGISTRATION_ATTEMPTS) {
		logger.error('Could not register whiteboard handler for viewer')
		return
	}

	window.setTimeout(
		() => registerViewerHandler(component, attempt + 1, afterRegister),
		VIEWER_REGISTRATION_DELAY_MS,
	)
}

const getViewerApi = (): ViewerApi | undefined =>
	(window as WindowWithViewer).OCA?.Viewer

const runWhenDomReady = (callback: () => void | Promise<void>): void => {
	if (document.readyState === 'loading') {
		const handler = () => {
			document.removeEventListener('DOMContentLoaded', handler)
			callback()
		}
		document.addEventListener('DOMContentLoaded', handler)
		return
	}

	callback()
}

const primeRecordingJwt = async (
	fileId: number,
	jwt: string,
): Promise<void> => {
	if (!jwt) {
		return
	}

	const { useJWTStore } = await import('./stores/useJwtStore')
	const payload = useJWTStore.getState().parseJwt(jwt)

	if (!payload) {
		return
	}

	useJWTStore.setState((state) => ({
		...state,
		tokens: {
			...state.tokens,
			[fileId]: jwt,
		},
		tokenExpiries: {
			...state.tokenExpiries,
			[fileId]: payload.exp,
		},
	}))
}

const normalizeNumericState = (value: unknown): number => {
	const normalized = Number(value)
	return Number.isFinite(normalized) ? normalized : 0
}

const generateWhiteboardElementId = () =>
	`whiteboard-${Math.random()
		.toString(36)
		.replace(/[^a-z]+/g, '')
		.substr(2, 10)}`

const createWhiteboardElement = (id = generateWhiteboardElementId()) => {
	const element = document.createElement('div')
	element.id = id
	element.className = 'whiteboard'
	return element
}

bootstrapWhiteboardRuntime()
