/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

// https://github.com/excalidraw/excalidraw/blob/4dc4590f247a0a0d9c3f5d39fe09c00c5cef87bf/examples/excalidraw

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Excalidraw,
	LiveCollaborationTrigger,
	MainMenu,
	sceneCoordsToViewportCoords,
	useHandleLibrary,
	viewportCoordsToSceneCoords
} from '@excalidraw/excalidraw'
import './App.scss'
import { distance2d, resolvablePromise, withBatchedUpdates, withBatchedUpdatesThrottled } from './utils'
import type {
	AppState,
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
	PointerDownState
} from '@excalidraw/excalidraw/types/types'
import { Collab } from './collaboration/collab'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'

type Comment = {
	x: number;
	y: number;
	value: string;
	id?: string;
};

const COMMENT_ICON_DIMENSION = 32

interface WhiteboardAppProps {
	fileId: number;
	isEmbedded: boolean;
}

export default function App({ fileId, isEmbedded }: WhiteboardAppProps) {
	const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches
	const appRef = useRef<any>(null)
	const [viewModeEnabled, setViewModeEnabled] = useState(isEmbedded)
	const [zenModeEnabled, setZenModeEnabled] = useState(isEmbedded)
	const [gridModeEnabled, setGridModeEnabled] = useState(false)
	const [blobUrl, setBlobUrl] = useState<string>('')
	const [canvasUrl, setCanvasUrl] = useState<string>('')
	const [exportWithDarkMode, setExportWithDarkMode] = useState(false)
	const [exportEmbedScene, setExportEmbedScene] = useState(false)
	const [theme, setTheme] = useState(darkMode ? 'dark' : 'light')
	const [isCollaborating, setIsCollaborating] = useState(false)
	const [commentIcons, setCommentIcons] = useState<{ [id: string]: Comment }>(
		{}
	)
	const [comment, setComment] = useState<Comment | null>(null)
	const initialData = {
		elements: [],
		scrollToContent: true
	}

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
	}>({ promise: null! })
	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
	}

	const [
		excalidrawAPI,
		setExcalidrawAPI
	] = useState<ExcalidrawImperativeAPI | null>(null)
	const [collab, setCollab] = useState<Collab | null>(null)

	if (excalidrawAPI && !collab) setCollab(new Collab(excalidrawAPI, fileId))
	if (collab && !collab.portal.socket) collab.startCollab()

	useEffect(() => {
		return () => {
			if (collab) collab.portal.disconnectSocket()
		}
	}, [excalidrawAPI])

	useHandleLibrary({ excalidrawAPI })

	useEffect(() => {
		if (!excalidrawAPI) {
			return
		}
		const fetchData = async () => {
			initialStatePromiseRef.current.promise.resolve(initialData)
		}

		fetchData().then()
	}, [excalidrawAPI])

	const onLinkOpen = useCallback(
		(
			element: NonDeletedExcalidrawElement,
			event: CustomEvent<{
				nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement>;
			}>
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
		[]
	)

	const onPointerDown = (
		activeTool: AppState['activeTool'],
		pointerDownState: any
	) => {
		if (activeTool.type === 'custom' && activeTool.customType === 'comment') {
			const { x, y } = pointerDownState.origin
			setComment({ x, y, value: '' })
		}
	}

	const renderMenu = () => {
		return (
			<MainMenu>
				<MainMenu.DefaultItems.ToggleTheme />
				<MainMenu.DefaultItems.ChangeCanvasBackground />
				<MainMenu.Separator />
				<MainMenu.DefaultItems.SaveAsImage />
				<MainMenu.DefaultItems.Export />
			</MainMenu>
		)
	}

	return (
		<div className="App" ref={appRef}>
			<div className="excalidraw-wrapper">
				<Excalidraw
					excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
						console.log(api)
						console.log('Setting API')
						setExcalidrawAPI(api)
					}}
					initialData={initialStatePromiseRef.current.promise}
					onChange={(elements, state) => {

					}}
					onPointerUpdate={collab?.onPointerUpdate}
					viewModeEnabled={viewModeEnabled}
					zenModeEnabled={zenModeEnabled}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					name="Custom name of drawing"
					UIOptions={{
						canvasActions: {
							loadScene: false
						}
					}}
					onLinkOpen={onLinkOpen}
					onPointerDown={onPointerDown}
				>
					{renderMenu()}
				</Excalidraw>
			</div>
		</div>
	)
}
