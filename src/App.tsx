/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

// https://github.com/excalidraw/excalidraw/blob/4dc4590f247a0a0d9c3f5d39fe09c00c5cef87bf/examples/excalidraw

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useState, memo } from 'react'
import {
	Excalidraw,
	useHandleLibrary,
} from '@excalidraw/excalidraw'
import './App.scss'
import type {
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types/types'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { useWhiteboardData } from './hooks/useWhiteboardData'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useThemeHandling } from './hooks/useThemeHandling'
import { useCollaboration } from './hooks/useCollaboration'
import { useSmartPicker } from './hooks/useSmartPicker'
import { ExcalidrawMenu } from './components/ExcalidrawMenu'
import Embeddable from './Embeddable'
import { useLangStore } from './stores/useLangStore'
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator'

const MemoizedNetworkStatusIndicator = memo(NetworkStatusIndicator)
const MemoizedExcalidrawMenu = memo(ExcalidrawMenu)

interface WhiteboardAppProps {
	fileId: number
	fileName: string
	isEmbedded: boolean
	publicSharingToken: string | null
}

export default function App({
	fileId,
	isEmbedded,
	fileName,
	publicSharingToken,
}: WhiteboardAppProps) {
	const fileNameWithoutExtension = fileName.split('.').slice(0, -1).join('.')

	const [viewModeEnabled, setViewModeEnabled] = useState(isEmbedded)
	const [zenModeEnabled] = useState(false)
	const [gridModeEnabled] = useState(false)
	const { theme } = useThemeHandling()
	const { excalidrawAPI, setExcalidrawAPI } = useExcalidrawStore()
	const [isInitialized, setIsInitialized] = useState(false)
	const { initialDataPromise } = useWhiteboardData(fileId, publicSharingToken)
	const { lang, updateLang } = useLangStore()
	const { onPointerUpdate, onChange } = useCollaboration(
		fileId,
		publicSharingToken,
		setViewModeEnabled,
	)
	const { renderSmartPicker } = useSmartPicker()
	const [isLoading, setIsLoading] = useState(true)

	useEffect(() => {
		const timer = setTimeout(() => {
			renderSmartPicker()
			setIsInitialized(true)
		}, 300)
		return () => clearTimeout(timer)
	}, [renderSmartPicker])

	useEffect(() => {
		if (isInitialized) {
			updateLang()
		}
	}, [isInitialized, updateLang])

	useHandleLibrary({ excalidrawAPI })

	// Memoize callback functions to prevent unnecessary re-renders
	const onLinkOpen = useCallback(
		(
			element: NonDeletedExcalidrawElement,
			event: CustomEvent<{
				nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement>
			}>,
		) => {
			const link = element.link!
			const { nativeEvent } = event.detail
			const isNewTab = nativeEvent.ctrlKey || nativeEvent.metaKey
			const isNewWindow = nativeEvent.shiftKey
			const isInternalLink
				= link.startsWith('/') || link.includes(window.location.origin)
			if (isInternalLink && !isNewTab && !isNewWindow) {
				// signal that we're handling the redirect ourselves
				event.preventDefault()
				// do a custom redirect, such as passing to react-router
				// ...
			}
		},
		[],
	)

	// Memoize excalidraw API callback
	const handleExcalidrawAPI = useCallback(
		(api: ExcalidrawImperativeAPI) => {
			setExcalidrawAPI(api)
		},
		[setExcalidrawAPI],
	)

	// Hide loading state after initial rendering
	useEffect(() => {
		const timer = setTimeout(() => {
			setIsLoading(false)
		}, 100)
		return () => clearTimeout(timer)
	}, [])

	return (
		<div className="App">
			{isLoading
				? (
					<div className="App-loading">
					Loading whiteboard...
					</div>
				)
				: (
					<>
						<MemoizedNetworkStatusIndicator />
						<div className="excalidraw-wrapper">
							<Excalidraw
								validateEmbeddable={() => true}
								renderEmbeddable={Embeddable}
								excalidrawAPI={handleExcalidrawAPI}
								initialData={initialDataPromise}
								onPointerUpdate={onPointerUpdate}
								onChange={onChange}
								viewModeEnabled={viewModeEnabled}
								zenModeEnabled={zenModeEnabled}
								gridModeEnabled={gridModeEnabled}
								theme={theme}
								name={fileNameWithoutExtension}
								UIOptions={{
									canvasActions: {
										loadScene: false,
									},
								}}
								onLinkOpen={onLinkOpen}
								langCode={lang}>
								<MemoizedExcalidrawMenu fileNameWithoutExtension={fileNameWithoutExtension} />
							</Excalidraw>
						</div>
					</>
				)}
		</div>
	)
}
