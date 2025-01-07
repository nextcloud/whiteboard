/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

// https://github.com/excalidraw/excalidraw/blob/4dc4590f247a0a0d9c3f5d39fe09c00c5cef87bf/examples/excalidraw

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@mdi/react'
import { mdiSlashForwardBox, mdiMonitorScreenshot } from '@mdi/js'
import { createRoot } from 'react-dom'
import {
	Excalidraw,
	MainMenu,
	useHandleLibrary,
	viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import './App.scss'
import { resolvablePromise } from './utils'
import type {
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types/types'
import { Collab } from './collaboration/collab'
import Embeddable from './Embeddable'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { getLinkWithPicker } from '@nextcloud/vue/dist/Components/NcRichText.js'
import { useExcalidrawLang } from './hooks/useExcalidrawLang'

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
	const [zenModeEnabled] = useState(isEmbedded)
	const [gridModeEnabled] = useState(false)

	const isDarkMode = () => {
		const ncThemes = document.body.dataset?.themes
		return (
			(window.matchMedia('(prefers-color-scheme: dark)').matches
				&& (ncThemes === undefined || ncThemes?.indexOf('light') === -1))
			|| ncThemes?.indexOf('dark') > -1
		)
	}
	const [theme, setTheme] = useState(isDarkMode() ? 'dark' : 'light')

	const lang = useExcalidrawLang()

	useEffect(() => {
		const themeChangeListener = () =>
			setTheme(isDarkMode() ? 'dark' : 'light')
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		mq.addEventListener('change', themeChangeListener)
		return () => {
			mq.removeEventListener('change', themeChangeListener)
		}
	}, [])

	const initialData = {
		elements: [],
		appState: {
			currentItemFontFamily: 3,
			currentItemStrokeWidth: 1,
			currentItemRoughness: 0,
		},
		scrollToContent: true,
	}

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>
	}>({ promise: null! })
	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
	}

	const [excalidrawAPI, setExcalidrawAPI]
		= useState<ExcalidrawImperativeAPI | null>(null)
	const [collab, setCollab] = useState<Collab | null>(null)

	if (excalidrawAPI && !collab) { setCollab(new Collab(excalidrawAPI, fileId, publicSharingToken, setViewModeEnabled)) }
	if (collab && !collab.portal.socket) collab.startCollab()
	useEffect(() => {
		const extraTools = document.getElementsByClassName(
			'App-toolbar__extra-tools-trigger',
		)[0]
		const smartPick = document.createElement('label')
		smartPick.classList.add(...['ToolIcon', 'Shape'])
		if (extraTools) {
			extraTools.parentNode?.insertBefore(
				smartPick,
				extraTools.previousSibling,
			)
			const root = createRoot(smartPick)
			root.render(renderSmartPicker())
		}
	})

	useEffect(() => {
		return () => {
			if (collab) collab.portal.disconnectSocket()
		}
	}, [excalidrawAPI])

	useEffect(() => {
		const handleBeforeUnload = () => {
			if (collab) collab.portal.disconnectSocket()
		}

		window.addEventListener('beforeunload', handleBeforeUnload)

		return () => {
			if (collab) collab.portal.disconnectSocket()
			window.removeEventListener('beforeunload', handleBeforeUnload)
		}
	}, [collab])

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
	const addWebEmbed = (link: string) => {
		let cords: { x: any; y: any }
		if (excalidrawAPI) {
			cords = viewportCoordsToSceneCoords(
				{ clientX: 100, clientY: 100 },
				excalidrawAPI.getAppState(),
			)
		} else {
			cords = { x: 0, y: 0 }
		}
		const elements = excalidrawAPI
			?.getSceneElementsIncludingDeleted()
			.slice()
		elements?.push({
			link,
			id: (Math.random() + 1).toString(36).substring(7),
			x: cords.x,
			y: cords.y,
			strokeColor: '#1e1e1e',
			backgroundColor: 'transparent',
			fillStyle: 'solid',
			strokeWidth: 2,
			strokeStyle: 'solid',
			roundness: null,
			roughness: 1,
			opacity: 100,
			width: 400,
			height: 200,
			angle: 0,
			seed: 0,
			version: 0,
			versionNonce: 0,
			isDeleted: false,
			groupIds: [],
			frameId: null,
			boundElements: null,
			updated: 0,
			locked: false,
			type: 'embeddable',
			validated: true,
		})
		excalidrawAPI?.updateScene({ elements })
	}
	const pickFile = () => {
		getLinkWithPicker(null, true).then((link: string) => {
			addWebEmbed(link)
		})
	}

	const takeScreenshot = () => {
		const dataUrl = document.querySelector('.excalidraw__canvas').toDataURL('image/png')
		const downloadLink = document.createElement('a')
		downloadLink.href = dataUrl
		downloadLink.download = `${fileNameWithoutExtension} Screenshot.png`
		document.body.appendChild(downloadLink)
		downloadLink.click()
	}

	const renderMenu = () => {
		return (
			<MainMenu>
				<MainMenu.DefaultItems.ToggleTheme />
				<MainMenu.DefaultItems.ChangeCanvasBackground />
				<MainMenu.Separator />
				<MainMenu.DefaultItems.SaveAsImage />
				<MainMenu.Item
					icon={<Icon path={mdiMonitorScreenshot} size="16px" />}
					onSelect={() => takeScreenshot()}>
					{ 'Download screenshot' }
				</MainMenu.Item>
			</MainMenu>
		)
	}

	const renderSmartPicker = () => {
		return (
			<button
				className="dropdown-menu-button App-toolbar__extra-tools-trigger"
				aria-label="Smart picker"
				aria-keyshortcuts="0"
				onClick={pickFile}
				title="Smart picker">
				<Icon path={mdiSlashForwardBox} size={1} />
			</button>
		)
	}

	return (
		<div className="App">
			<div className="excalidraw-wrapper">
				<Excalidraw
					validateEmbeddable={() => true}
					renderEmbeddable={Embeddable}
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
					name={fileNameWithoutExtension}
					UIOptions={{
						canvasActions: {
							loadScene: false,
						},
					}}
					onLinkOpen={onLinkOpen}
					langCode={lang}>
					{renderMenu()}
				</Excalidraw>
			</div>
		</div>
	)
}
