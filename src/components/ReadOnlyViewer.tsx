/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { t } from '@nextcloud/l10n'
import { Excalidraw as ExcalidrawComponent, restoreElements } from '@nextcloud/excalidraw'
import type {
	AppState,
	BinaryFiles,
	ExcalidrawElement,
	ExcalidrawInitialDataState,
} from '@nextcloud/excalidraw/dist/types/excalidraw/types'

import '@excalidraw/excalidraw/index.css'

import logger from '../utils/logger'
import type { WhiteboardAppProps } from '../App'
import { initialDataState } from '../constants/excalidraw'
import { useThemeHandling } from '../hooks/useThemeHandling'

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
	const parsed = { ...(state as Partial<AppState>) }
	delete parsed.collaborators
	delete parsed.selectedElementIds
	return {
		...fallback,
		...parsed,
	}
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
	const { theme } = useThemeHandling()

	const langCode = useMemo(() => document.documentElement.lang || 'en', [])

	useEffect(() => {
		if (!versionSource) {
			setError(t('whiteboard', 'This version is missing its source file'))
			setScene(null)
			return
		}

		const abortController = new AbortController()

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

				const elements = sanitizeElements(parsed.elements)
				const files = sanitizeFiles(parsed.files)
				const appState = sanitizeAppState(parsed.appState)

				setScene({
					elements,
					files,
					appState,
					scrollToContent: parsed.scrollToContent ?? true,
				})
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

		loadScene()

		return () => {
			abortController.abort()
		}
	}, [versionSource])

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
		<div className="App App--version-preview" style={{ display: 'flex', flexDirection: 'column' }}>
			<div className="excalidraw-wrapper" style={{ flex: 1, height: '100%', position: 'relative' }}>
				<ReadOnlyExcalidraw
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
