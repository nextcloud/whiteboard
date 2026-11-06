/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@nextcloud/l10n'
import { Excalidraw as ExcalidrawComponent, restoreElements } from '@nextcloud/excalidraw'
import type { ExcalidrawElement } from '@nextcloud/excalidraw/element/types'
import type {
	AppState,
	BinaryFileData,
	BinaryFiles,
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
} from '@nextcloud/excalidraw/types'

import '@excalidraw/excalidraw/index.css'

import logger from '../utils/logger'
import type { WhiteboardAppProps } from '../App'
import { initialDataState } from '../constants/excalidraw'
import { useThemeHandling } from '../hooks/useThemeHandling'
import { sanitizeAppStateForSync } from '../utils/sanitizeAppState'

const ReadOnlyExcalidraw = memo(ExcalidrawComponent)

type ParsedVersionContent = {
	elements?: unknown
	files?: unknown
	appState?: unknown
	scrollToContent?: boolean
}

type SceneState = ExcalidrawInitialDataState & {
	scrollToContent?: boolean
}

const sanitizeElements = (elements: unknown): ExcalidrawElement[] => {
	if (!Array.isArray(elements)) {
		return []
	}
	return restoreElements(elements as ExcalidrawElement[], null) as ExcalidrawElement[]
}

const sanitizeFiles = (files: unknown): BinaryFiles => {
	if (files && typeof files === 'object') {
		return files as BinaryFiles
	}
	return {}
}

const sanitizeAppState = (state: unknown): Partial<AppState> => {
	const fallback = { ...initialDataState.appState }
	if (!state || typeof state !== 'object') {
		return fallback
	}
	const parsed = sanitizeAppStateForSync(state as Partial<AppState>)
	return {
		...fallback,
		...parsed,
	}
}

// An embedded board (in Talk or Text) shows edits made after it opened; a version never changes
const EMBED_REFRESH_INTERVAL = 60_000
function isFixedVersion(source: string, fileVersion: string | null | undefined): boolean {
	return Boolean(fileVersion) || source.includes('/dav/versions/') || source.includes('/dav/trashbin/')
}

const resolveVersionSource = (source: string) => {
	try {
		const url = new URL(source, window.location.origin)
		return url.toString()
	} catch {
		return source
	}
}

export default function ReadOnlyViewer({
	fileName,
	versionSource,
	fileVersion,
}: WhiteboardAppProps) {
	const [scene, setScene] = useState<SceneState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
	const { theme, themeAttributes } = useThemeHandling()

	const langCode = useMemo(() => document.documentElement.lang || 'en', [])

	useEffect(() => {
		if (!versionSource) {
			setError(t('whiteboard', 'This version is missing its source file'))
			setScene(null)
			return
		}

		const abortController = new AbortController()
		let etag: string | null = null
		// The settings stored with the board; a refresh applies them only when they change, so the view does not jump
		let storedAppState = 'null'

		let loaded = false
		const loadScene = async () => {
			setIsLoading(true)
			setError(null)
			try {
				const response = await fetch(resolveVersionSource(versionSource), {
					method: 'GET',
					credentials: 'include',
					signal: abortController.signal,
					headers: {
						Accept: 'application/json',
					},
				})

				if (!response.ok) {
					throw new Error(`Unexpected response ${response.status}`)
				}

				etag = response.headers.get('ETag')
				const rawContent = await response.text()
				if (abortController.signal.aborted) {
					return
				}

				let parsed: ParsedVersionContent = {}
				if (rawContent.trim().length > 0) {
					try {
						parsed = JSON.parse(rawContent) as ParsedVersionContent
					} catch (parseError) {
						throw new Error('Failed to parse version JSON')
					}
				}

				storedAppState = JSON.stringify(parsed.appState ?? null)
				const elements = sanitizeElements(parsed.elements)
				const files = sanitizeFiles(parsed.files)
				const appState = sanitizeAppState(parsed.appState)

				setScene({
					elements,
					files,
					appState,
					scrollToContent: parsed.scrollToContent ?? true,
				})
				loaded = true
			} catch (fetchError) {
				if (abortController.signal.aborted) {
					return
				}
				logger.error('[ReadOnlyViewer] Failed to load scene', fetchError)
				setError(t('whiteboard', 'Could not load this version'))
				setScene(null)
			} finally {
				if (!abortController.signal.aborted) {
					setIsLoading(false)
				}
			}
		}

		// One load or refresh at a time, so an older answer never replaces a newer one
		let refreshing = true
		void loadScene().finally(() => {
			refreshing = false
		})

		const refresh = async () => {
			if (refreshing || document.visibilityState !== 'visible') {
				return
			}
			if (!loaded) {
				// The first load failed: try it again
				refreshing = true
				await loadScene()
				refreshing = false
				return
			}
			if (!apiRef.current) {
				return
			}
			refreshing = true
			try {
				const response = await fetch(resolveVersionSource(versionSource), {
					credentials: 'include',
					signal: abortController.signal,
					headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
				})
				if (response.status !== 200 || !apiRef.current) {
					return
				}
				// Blank bytes are an empty board
				const text = await response.text()
				const parsed = (text.trim() === '' ? {} : JSON.parse(text)) as ParsedVersionContent
				apiRef.current.addFiles(Object.values(sanitizeFiles(parsed.files)) as BinaryFileData[])
				const appState = JSON.stringify(parsed.appState ?? null)
				apiRef.current.updateScene({
					elements: sanitizeElements(parsed.elements),
					...(appState !== storedAppState ? { appState: { ...apiRef.current.getAppState(), ...sanitizeAppStateForSync(parsed.appState as Partial<AppState>) } } : {}),
				})
				storedAppState = appState
				etag = response.headers.get('ETag')
			} catch (refreshError) {
				logger.debug('[ReadOnlyViewer] Could not refresh the embedded board', refreshError)
			} finally {
				refreshing = false
			}
		}
		const interval = isFixedVersion(versionSource, fileVersion) ? undefined : setInterval(refresh, EMBED_REFRESH_INTERVAL)

		return () => {
			abortController.abort()
			clearInterval(interval)
		}
	}, [versionSource, fileVersion])

	const title = useMemo(() => {
		if (!fileVersion) {
			return fileName
		}
		return t('whiteboard', '{fileName} – Version {version}', {
			fileName,
			version: fileVersion,
		})
	}, [fileName, fileVersion])

	if (error) {
		return (
			<div className="App App--version-preview" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				<div>{error}</div>
			</div>
		)
	}

	if (isLoading || !scene) {
		return (
			<div className="App" style={{ display: 'flex', flexDirection: 'column' }}>
				<div className="App-loading" style={{
					flex: 1,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}>
					{t('whiteboard', 'Loading version...')}
				</div>
			</div>
		)
	}

	const canvasActions = {
		changeViewBackgroundColor: false,
		clearCanvas: false,
		export: false,
		loadScene: false,
		saveAsImage: false,
		saveToActiveFile: false,
		toggleTheme: false,
	}

	return (
		<div className="App App--version-preview" style={{ display: 'flex', flexDirection: 'column' }} {...themeAttributes}>
			<div className="excalidraw-wrapper" style={{ flex: 1, height: '100%', position: 'relative' }}>
				<ReadOnlyExcalidraw
					onExcalidrawAPI={(api: ExcalidrawImperativeAPI | null) => {
						apiRef.current = api
					}}
					initialData={scene}
					viewModeEnabled
					zenModeEnabled={false}
					gridModeEnabled={false}
					theme={theme}
					name={title}
					UIOptions={{ canvasActions }}
					langCode={langCode}
				/>
			</div>
		</div>
	)
}
