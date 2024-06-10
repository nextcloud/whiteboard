/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Excalidraw,
	LiveCollaborationTrigger,
	MainMenu,
	sceneCoordsToViewportCoords,
	useHandleLibrary
} from '@excalidraw/excalidraw'
import './App.scss'
import { resolvablePromise } from './utils'

import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types/types'
import { Collab } from './collaboration/collab'
import type { ResolvablePromise } from '@excalidraw/excalidraw/types/utils'
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'

declare global {
	interface Window {
		ExcalidrawLib: any;
	}
}

type Comment = {
	x: number;
	y: number;
	value: string;
	id?: string;
};

const COMMENT_ICON_DIMENSION = 32

/**
 *
 */
export default function App() {
	const appRef = useRef<any>(null)
	const [viewModeEnabled] = useState(false)
	const [zenModeEnabled] = useState(false)
	const [gridModeEnabled] = useState(false)
	const [theme] = useState('light')
	const [isCollaborating] = useState(true)
	const [commentIcons, setCommentIcons] = useState<{ [id: string]: Comment }>(
		{}
	)
	const [comments, setComment] = useState<Comment | null>(null)
	const initialData = {
		elements: [],
		scrollToContent: true
	}

	const initialStatePromiseRef = useRef<{
		promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
	}>({ promise: null! })
	if (!initialStatePromiseRef.current.promise) {
		initialStatePromiseRef.current.promise = resolvablePromise<ExcalidrawInitialDataState | null>()
	}

	const [
		excalidrawAPI,
		setExcalidrawAPI
	] = useState<ExcalidrawImperativeAPI | null>(null)
	const [collab, setCollab] = useState<Collab | null>(null)

	if (excalidrawAPI && !collab) setCollab(new Collab(excalidrawAPI))
	if (collab && !collab.portal.socket) collab.startCollab()

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

	const renderTopRightUI = (isMobile: boolean) => {
		return (
			<>
				{!isMobile && (
					<LiveCollaborationTrigger
						isCollaborating={isCollaborating}
						onSelect={() => {
							window.alert('Collab dialog clicked')
						}}
					/>
				)}
			</>
		)
	}

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

	const rerenderCommentIcons = () => {
		if (!excalidrawAPI) {
			return false
		}
		const commentIconsElements = appRef.current.querySelectorAll(
			'.comment-icon'
		) as HTMLElement[]
		commentIconsElements.forEach((ele) => {
			const id = ele.id
			const appstate = excalidrawAPI.getAppState()
			const { x, y } = sceneCoordsToViewportCoords(
				{ sceneX: commentIcons[id].x, sceneY: commentIcons[id].y },
				appstate
			)
			ele.style.left = `${
				x - COMMENT_ICON_DIMENSION / 2 - appstate!.offsetLeft
			}px`
			ele.style.top = `${
				y - COMMENT_ICON_DIMENSION / 2 - appstate!.offsetTop
			}px`
		})
	}

	const renderMenu = () => {
		return (
			<MainMenu>
				<MainMenu.DefaultItems.ToggleTheme />
				<MainMenu.DefaultItems.ChangeCanvasBackground />
			</MainMenu>
		)
	}

	return (
		<div className="App" ref={appRef}>
			<div className="excalidraw-wrapper">
				<Excalidraw
					excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
						setExcalidrawAPI(api)
					}}
					initialData={initialStatePromiseRef.current.promise}
					onChange={(elements, state) => {
						console.info('Elements :', elements, 'State : ', state)
					}}
					onPointerUpdate={collab?.onPointerUpdate}
					viewModeEnabled={viewModeEnabled}
					zenModeEnabled={zenModeEnabled}
					gridModeEnabled={gridModeEnabled}
					theme={theme}
					autoFocus={true}
					name="Whiteboard"
					UIOptions={{
						canvasActions: { loadScene: false }
					}}
					renderTopRightUI={renderTopRightUI}
					onLinkOpen={onLinkOpen}
					onPointerDown={onPointerDown}
					onScrollChange={rerenderCommentIcons}
				>
					{renderMenu()}
				</Excalidraw>
			</div>
		</div>
	)
}
