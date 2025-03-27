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
import { useWhiteboard } from './hooks/useWhiteboard'
import { useExcalidrawStore } from './stores/useExcalidrawStore'
import { useWhiteboardStore } from './stores/useWhiteboardStore'
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
	const { setExcalidrawAPI } = useExcalidrawStore()
	const [isInitialized, setIsInitialized] = useState(false)
	const { setConfig } = useWhiteboardStore()
	const { initialDataPromise, onChange: onWhiteboardDataChange } = useWhiteboard()
	const { lang, updateLang } = useLangStore()
	const { onPointerUpdate, onChange: onCollaborationChange } = useCollaboration(setViewModeEnabled)
	const { renderSmartPicker } = useSmartPicker()
	const [isLoading, setIsLoading] = useState(true)

	useEffect(() => {
		setConfig({
			fileId,
			fileName,
			publicSharingToken,
			isReadOnly: false,
			isEmbedded,
		})
	}, [fileId, fileName, publicSharingToken, isEmbedded, setConfig])

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

	useHandleLibrary({ excalidrawAPI: useExcalidrawStore(state => state.excalidrawAPI) })

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
				event.preventDefault()
			}
		},
		[],
	)

	const handleExcalidrawAPI = useCallback(
		(api: ExcalidrawImperativeAPI) => {
			setExcalidrawAPI(api)
		},
		[setExcalidrawAPI],
	)

	const handleOnChange = useCallback((elements: any, appState: any, files: any) => {
		onWhiteboardDataChange(elements, appState, files)
		onCollaborationChange(elements, appState, files)
	}, [onWhiteboardDataChange, onCollaborationChange])

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
								onChange={handleOnChange}
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
