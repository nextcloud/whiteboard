/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ViewerComponentDefinition } from './viewer/legacyViewerComponent.ts'

import { loadState } from '@nextcloud/initial-state'
import { linkTo } from '@nextcloud/router'
import { getSharingToken, isPublicShare } from '@nextcloud/sharing/public'
import logger from './utils/logger'
import { callMobileMessage } from './utils/mobileInterface'
import { renderWhiteboardView } from './utils/renderWhiteboardView'
import { createWhiteboardComponent, generateWhiteboardElementId } from './viewer/legacyViewerComponent.ts'

import './styles/index.scss'
import '@nextcloud/dialogs/style.css'

declare global {
	interface Window {
		EXCALIDRAW_ASSET_PATH?: string | string[]
		updateRecordingJwt?: (jwt: string) => Promise<void>
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

type DirectEditingContext = {
	fileId: number
	collabBackendUrl: string
	jwt: string
}

type ViewerContext = {
	collabBackendUrl: string
	resolveSharingToken: () => string | null
}

type RuntimeDescriptor
	= | { type: 'recording', context: RecordingContext }
		| { type: 'public-share', context: PublicShareContext }
		| { type: 'direct-editing', context: DirectEditingContext }
		| { type: 'viewer', context: ViewerContext }

const VIEWER_REGISTRATION_ATTEMPTS = 3
const VIEWER_REGISTRATION_DELAY_MS = 250

function bootstrapWhiteboardRuntime(): void {
	const runtime = detectRuntime()

	switch (runtime.type) {
		case 'recording':
			runRecordingRuntime(runtime.context)
			return
		case 'public-share':
			runPublicShareRuntime(runtime.context)
			return
		case 'direct-editing':
			runDirectEditingRuntime(runtime.context)
			return
		case 'viewer':
		default:
			runDefaultViewerRuntime(runtime.context)
	}
}

function detectRuntime(): RuntimeDescriptor {
	const fileId = normalizeNumericState(loadState('whiteboard', 'file_id', '0'))
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

	if (loadState('whiteboard', 'directEditing', false)) {
		return {
			type: 'direct-editing',
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
		// The recording backend renews the bot's token, which cannot be refreshed without a login session
		window.updateRecordingJwt = async (jwt: string) => {
			await primeRecordingJwt(context.fileId, jwt)
			// A refresh timer of an earlier token would ask Nextcloud, which only works with a login session
			const { useJWTStore } = await import('./stores/useJwtStore.ts')
			useJWTStore.getState().clearAutoRefresh(String(context.fileId))
			const { useCollaborationStore } = await import('./stores/useCollaborationStore.ts')
			const { socket } = useCollaborationStore.getState()
			if (socket) {
				socket.auth = { ...socket.auth, token: jwt }
			}
		}

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

function runDirectEditingRuntime(context: DirectEditingContext): void {
	runWhenDomReady(async () => {
		await primeRecordingJwt(context.fileId, context.jwt)

		const whiteboardElement = document.getElementById('whiteboard-app')
		if (!whiteboardElement) {
			logger.error('Direct editing mount element not found')
			return
		}

		callMobileMessage('loading')

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

/**
 * Whether the viewer is the viewer app of Nextcloud 35 and older. From 36,
 * whiteboard-viewer registers the handler and the server opens a shared board
 * in the viewer itself. This script still runs there, as the board's code
 * shares chunks with it.
 */
function usesLegacyViewer(): boolean {
	return loadState('whiteboard', 'legacyViewer', true)
}

function runPublicShareRuntime(context: PublicShareContext): void {
	if (!usesLegacyViewer()) {
		return
	}

	const viewerContext: ViewerContext = {
		collabBackendUrl: context.collabBackendUrl,
		resolveSharingToken: () => context.sharingToken,
	}

	let hasOpenedInViewer = false
	const isWhiteboardPublicShare = (): boolean => {
		// LoadViewer triggers whiteboard-main on all public shares; only continue if
		// this share was explicitly marked as a whiteboard file by the backend.
		if (!context.fileId) {
			return false
		}

		// On NC29/30, there's a hidden input with id="mimetype" that we can check.
		// On NC31+, this element doesn't exist, so we rely on the backend-provided
		// whiteboard file id check above.
		const mimetypeElmt = document.getElementById('mimetype') as HTMLInputElement | null
		if (mimetypeElmt && mimetypeElmt.value !== 'application/vnd.excalidraw+json') {
			return false
		}

		return true
	}

	const ensurePublicShareLayout = (): void => {
		document.body.classList.add('whiteboard-public-share')
	}

	const openInViewer = (): void => {
		if (!isWhiteboardPublicShare()) {
			hasOpenedInViewer = true
			return
		}

		if (hasOpenedInViewer) {
			return
		}

		ensurePublicShareLayout()

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

		if (!isWhiteboardPublicShare()) {
			return
		}

		const previewHost = document.getElementById('preview') || document.getElementById('imgframe')
		if (!previewHost) {
			return
		}

		ensurePublicShareLayout()

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
	if (!usesLegacyViewer()) {
		return
	}

	runWhenDomReady(() => {
		registerViewerHandler(createWhiteboardComponent(context))
	})
}

type ViewerHandlerRegistration = {
	id: string
	mimes: string[]
	component: ViewerComponentDefinition
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

function registerViewerHandler(component: ViewerComponentDefinition, attempt = 0, afterRegister?: () => void): void {
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

function getViewerApi(): ViewerApi | undefined {
	return (window as WindowWithViewer).OCA?.Viewer
}

function runWhenDomReady(callback: () => void | Promise<void>): void {
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

async function primeRecordingJwt(fileId: number, jwt: string): Promise<void> {
	if (!jwt) {
		return
	}

	const { localTokenExpiry, useJWTStore } = await import('./stores/useJwtStore')
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
			[fileId]: localTokenExpiry(payload),
		},
	}))
}

function normalizeNumericState(value: unknown): number {
	const normalized = Number(value)
	return Number.isFinite(normalized) ? normalized : 0
}

function createWhiteboardElement(id = generateWhiteboardElementId()) {
	const element = document.createElement('div')
	element.id = id
	element.className = 'whiteboard'
	return element
}

bootstrapWhiteboardRuntime()
