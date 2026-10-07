/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadState } from '@nextcloud/initial-state'
import { linkTo } from '@nextcloud/router'
import logger from './utils/logger'
import { callMobileMessage } from './utils/mobileInterface'
import { renderWhiteboardView } from './utils/renderWhiteboardView'

import './styles/index.scss'
import '@nextcloud/dialogs/style.css'

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

type DirectEditingContext = {
	fileId: number
	collabBackendUrl: string
	jwt: string
}

/**
 * The pages whiteboard renders itself. In the viewer, the board is shown by
 * the element registered in viewer.ts.
 */
function bootstrapWhiteboardRuntime(): void {
	const fileId = normalizeNumericState(loadState('whiteboard', 'file_id', '0'))
	const collabBackendUrl = loadState('whiteboard', 'collabBackendUrl', '')

	if (loadState('whiteboard', 'isRecording', false)) {
		runRecordingRuntime({ fileId, collabBackendUrl, jwt: loadState('whiteboard', 'jwt', '') })
		return
	}

	if (loadState('whiteboard', 'directEditing', false)) {
		runDirectEditingRuntime({ fileId, collabBackendUrl, jwt: loadState('whiteboard', 'jwt', '') })
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

function normalizeNumericState(value: unknown): number {
	const normalized = Number(value)
	return Number.isFinite(normalized) ? normalized : 0
}

function generateWhiteboardElementId() {
	return `whiteboard-${Math.random()
		.toString(36)
		.replace(/[^a-z]+/g, '')
		.substr(2, 10)}`
}

function createWhiteboardElement(id = generateWhiteboardElementId()) {
	const element = document.createElement('div')
	element.id = id
	element.className = 'whiteboard'
	return element
}

bootstrapWhiteboardRuntime()
