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
	MainMenu,
	useHandleLibrary,
} from '@excalidraw/excalidraw'
import './App.scss'
import { resolvablePromise } from './utils'
import type {
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types/types'
import { Collab } from './collaboration/collab'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
interface WhiteboardAppProps {
	fileId: number;
	isEmbedded: boolean;
}

export default function App({ fileId, isEmbedded }: WhiteboardAppProps) {
	const [viewModeEnabled] = useState(isEmbedded)
	const [zenModeEnabled] = useState(isEmbedded)
	const [gridModeEnabled] = useState(false)

	const isDarkMode = () => {
		const ncThemes = document.body.dataset?.themes
		return (window.matchMedia('(prefers-color-scheme: dark)').matches && ncThemes?.indexOf('light') === -1)
			|| ncThemes?.indexOf('dark') > -1
	}
	const [theme, setTheme] = useState(isDarkMode() ? 'dark' : 'light')

	useEffect(() => {
		const themeChangeListener = () => setTheme(isDarkMode() ? 'dark' : 'light')
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		mq.addEventListener('change', themeChangeListener)
		return () => {
			mq.removeEventListener('change', themeChangeListener)
		}
	}, [])

	const initialData = {
		elements: [],
		scrollToContent: true,
	}

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
	}>({ promise: null! })
	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
	}

	const [
		excalidrawAPI,
		setExcalidrawAPI,
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

	const renderMenu = () => {
		return (
			<MainMenu>
				<MainMenu.DefaultItems.ToggleTheme />
				<MainMenu.DefaultItems.ChangeCanvasBackground />
				<MainMenu.Separator />
				<MainMenu.DefaultItems.SaveAsImage />
			</MainMenu>
		)
	}

	return (
		<div className="App">
			<div className="excalidraw-wrapper">
				<Excalidraw
					excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
						console.log(api)
						console.log('Setting API')
						setExcalidrawAPI(api)
					}}
					initialData={initialStatePromiseRef.current.promise}
					onPointerUpdate={collab?.onPointerUpdate}
					viewModeEnabled={viewModeEnabled}
					zenModeEnabled={zenModeEnabled}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					name="Custom name of drawing"
					UIOptions={{
						canvasActions: {
							loadScene: false,
						},
					}}
					onLinkOpen={onLinkOpen}
				>
					{renderMenu()}
				</Excalidraw>
			</div>
		</div>
	)
}
