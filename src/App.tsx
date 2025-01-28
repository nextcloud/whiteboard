/**
 * SPDX-FileCopyrightText: 2020 Excalidraw, 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useRecording } from './hooks/useRecording'
import { Icon } from '@mdi/react'
import { mdiSlashForwardBox, mdiMonitorScreenshot } from '@mdi/js'
import { createRoot } from 'react-dom/client'
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
import { Recording } from './components/Recording'

interface WhiteboardAppProps {
	fileId: number
	fileName: string
	isEmbedded: boolean
	publicSharingToken: string | null
	collabBackendUrl: string
}

const isDarkMode = () => {
	const ncThemes = document.body.dataset?.themes || ''
	return (
		(window.matchMedia('(prefers-color-scheme: dark)').matches
			&& (ncThemes === undefined || ncThemes?.indexOf('light') === -1))
		|| ncThemes?.indexOf('dark') > -1
	)
}

export default function App({
	fileId,
	isEmbedded,
	fileName,
	publicSharingToken,
	collabBackendUrl,
}: WhiteboardAppProps) {
	const fileNameWithoutExtension = useMemo(
		() => fileName.split('.').slice(0, -1).join('.'),
		[fileName],
	)

	const [viewModeEnabled, setViewModeEnabled] = useState(isEmbedded)
	const [zenModeEnabled] = useState(isEmbedded)
	const [gridModeEnabled] = useState(false)
	const [theme, setTheme] = useState<'dark' | 'light'>(isDarkMode() ? 'dark' : 'light')
	const lang = useExcalidrawLang()

	useEffect(() => {
		const themeChangeListener = () => setTheme(isDarkMode() ? 'dark' : 'light')
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		mq.addEventListener('change', themeChangeListener)
		return () => mq.removeEventListener('change', themeChangeListener)
	}, [])

	const initialData = useMemo(() => ({
		elements: [],
		appState: {
			currentItemFontFamily: 3,
			currentItemStrokeWidth: 1,
			currentItemRoughness: 0,
		},
		scrollToContent: true,
	}), [])

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>
	}>({ promise: null! })

	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise()
	}

	const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)
	const [collab, setCollab] = useState<Collab | null>(null)

	useEffect(() => {
		if (excalidrawAPI && !collab) {
			setCollab(new Collab(
				excalidrawAPI,
				fileId,
				publicSharingToken,
				setViewModeEnabled,
				collabBackendUrl,
			))
		}
		if (collab && !collab.portal.socket) collab.startCollab()
	}, [excalidrawAPI, collab, fileId, publicSharingToken, collabBackendUrl])

	const smartPickerRef = useRef<HTMLLabelElement | null>(null)
	const renderSmartPicker = useCallback(() => (
		<button
			className="dropdown-menu-button App-toolbar__extra-tools-trigger"
			aria-label="Smart picker"
			aria-keyshortcuts="0"
			onClick={pickFile}
			title="Smart picker">
			<Icon path={mdiSlashForwardBox} size={1} />
		</button>
	), [])

	useEffect(() => {
		if (smartPickerRef.current) return
		const extraTools = document.getElementsByClassName('App-toolbar__extra-tools-trigger')[0]
		if (!extraTools) return

		const smartPick = document.createElement('label')
		smartPick.classList.add('ToolIcon', 'Shape')
		extraTools.parentNode?.insertBefore(smartPick, extraTools.previousSibling)
		const root = createRoot(smartPick)
		root.render(renderSmartPicker())
		smartPickerRef.current = smartPick

		return () => {
			smartPickerRef.current?.remove()
			smartPickerRef.current = null
		}
	}, [renderSmartPicker])

	useEffect(() => {
		const handleBeforeUnload = () => collab?.portal.disconnectSocket()
		window.addEventListener('beforeunload', handleBeforeUnload)
		return () => {
			collab?.portal.disconnectSocket()
			window.removeEventListener('beforeunload', handleBeforeUnload)
		}
	}, [collab])

	useHandleLibrary({ excalidrawAPI })

	useEffect(() => {
		if (excalidrawAPI) {
			initialStatePromiseRef.current.promise.resolve(initialData)
		}
	}, [excalidrawAPI, initialData])

	const onLinkOpen = useCallback((
		element: NonDeletedExcalidrawElement,
		event: CustomEvent<{ nativeEvent: MouseEvent }>,
	) => {
		const { link } = element
		const { nativeEvent } = event.detail
		if (!link) return

		const isInternalLink = link.startsWith('/') || link.includes(window.location.origin)
		const shouldPreventDefault = isInternalLink && !(nativeEvent.ctrlKey || nativeEvent.metaKey || nativeEvent.shiftKey)

		if (shouldPreventDefault) {
			event.preventDefault()
		}
	}, [])

	const addWebEmbed = useCallback((link: string) => {
		const cords = excalidrawAPI
			? viewportCoordsToSceneCoords(
				{ clientX: 100, clientY: 100 },
				excalidrawAPI.getAppState(),
			)
			: { x: 0, y: 0 }

		const newElement = {
			link,
			id: (Math.random() + 1).toString(36).substring(7),
			...cords,
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
		}

		excalidrawAPI?.updateScene({
			elements: [...excalidrawAPI.getSceneElementsIncludingDeleted(), newElement],
		})
	}, [excalidrawAPI])

	const pickFile = useCallback(() => {
		getLinkWithPicker(null, true).then((link: string) => addWebEmbed(link))
	}, [addWebEmbed])

	const takeScreenshot = useCallback(() => {
		const canvas = document.querySelector<HTMLCanvasElement>('.excalidraw__canvas')
		if (!canvas) return

		const dataUrl = canvas.toDataURL('image/png')
		const downloadLink = document.createElement('a')
		downloadLink.href = dataUrl
		downloadLink.download = `${fileNameWithoutExtension} Screenshot.png`
		document.body.appendChild(downloadLink)
		downloadLink.click()
		document.body.removeChild(downloadLink)
	}, [fileNameWithoutExtension])

	const recordingState = useRecording({
		collab: collab!,
		fileId,
	})

	const recordingUI = Recording({
		...recordingState,
		otherRecordingUsers: recordingState.otherUsers,
		hasOtherRecordingUsers: recordingState.hasOtherRecordingUsers,
		resetError: recordingState.resetError,
		dismissSuccess: recordingState.dismissSuccess,
	})

	const renderMenu = useCallback(() => (
		<MainMenu>
			<MainMenu.DefaultItems.ToggleTheme />
			<MainMenu.DefaultItems.ChangeCanvasBackground />
			<MainMenu.Separator />
			<MainMenu.DefaultItems.SaveAsImage />
			<MainMenu.Item
				icon={<Icon path={mdiMonitorScreenshot} size="16px" />}
				onSelect={takeScreenshot}>
				Download screenshot
			</MainMenu.Item>
			{recordingUI.renderRecordingMenuItem()}
		</MainMenu>
	), [takeScreenshot, recordingUI.renderRecordingMenuItem])

	return (
		<div className="App">
			<div className="excalidraw-wrapper">
				<Excalidraw
					validateEmbeddable={() => true}
					renderEmbeddable={({ link }) => link ? <Embeddable link={link} /> : null}
					excalidrawAPI={setExcalidrawAPI}
					initialData={initialStatePromiseRef.current.promise}
					onPointerUpdate={collab?.onPointerUpdate}
					viewModeEnabled={viewModeEnabled}
					zenModeEnabled={zenModeEnabled}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					name={fileNameWithoutExtension}
					UIOptions={{ canvasActions: { loadScene: false } }}
					onLinkOpen={onLinkOpen}
					langCode={lang}>
					{renderMenu()}
				</Excalidraw>
				{recordingUI.renderRecordingOverlay()}
			</div>
		</div>
	)
}
