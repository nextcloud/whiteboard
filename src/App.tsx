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

	const onPointerMoveFromPointerDownHandler = (
		pointerDownState: PointerDownState
	) => {
		return withBatchedUpdatesThrottled((event) => {
			if (!excalidrawAPI) {
				return false
			}
			const { x, y } = viewportCoordsToSceneCoords(
				{
					clientX: event.clientX - pointerDownState.hitElementOffsets.x,
					clientY: event.clientY - pointerDownState.hitElementOffsets.y
				},
				excalidrawAPI.getAppState()
			)
			setCommentIcons({
				...commentIcons,
				[pointerDownState.hitElement.id!]: {
					...commentIcons[pointerDownState.hitElement.id!],
					x,
					y
				}
			})
		})
	}
	const onPointerUpFromPointerDownHandler = (
		pointerDownState: PointerDownState
	) => {
		return withBatchedUpdates((event) => {
			window.removeEventListener('pointermove', pointerDownState.onMove)
			window.removeEventListener('pointerup', pointerDownState.onUp)
			excalidrawAPI?.setActiveTool({ type: 'selection' })
			const distance = distance2d(
				pointerDownState.x,
				pointerDownState.y,
				event.clientX,
				event.clientY
			)
			if (distance === 0) {
				if (!comment) {
					setComment({
						x: pointerDownState.hitElement.x + 60,
						y: pointerDownState.hitElement.y,
						value: pointerDownState.hitElement.value,
						id: pointerDownState.hitElement.id
					})
				} else {
					setComment(null)
				}
			}
		})
	}
	const saveComment = () => {
		if (!comment) {
			return
		}
		if (!comment.id && !comment.value) {
			setComment(null)
			return
		}
		const id = comment.id || nanoid()
		setCommentIcons({
			...commentIcons,
			[id]: {
				x: comment.id ? comment.x - 60 : comment.x,
				y: comment.y,
				id,
				value: comment.value
			}
		})
		setComment(null)
	}

	const renderCommentIcons = () => {
		return Object.values(commentIcons).map((commentIcon) => {
			if (!excalidrawAPI) {
				return false
			}
			const appState = excalidrawAPI.getAppState()
			const { x, y } = sceneCoordsToViewportCoords(
				{ sceneX: commentIcon.x, sceneY: commentIcon.y },
				excalidrawAPI.getAppState()
			)
			return (
				<div
					id={commentIcon.id}
					key={commentIcon.id}
					style={{
						top: `${y - COMMENT_ICON_DIMENSION / 2 - appState!.offsetTop}px`,
						left: `${x - COMMENT_ICON_DIMENSION / 2 - appState!.offsetLeft}px`,
						position: 'absolute',
						zIndex: 1,
						width: `${COMMENT_ICON_DIMENSION}px`,
						height: `${COMMENT_ICON_DIMENSION}px`,
						cursor: 'pointer',
						touchAction: 'none'
					}}
					className="comment-icon"
					onPointerDown={(event) => {
						event.preventDefault()
						if (comment) {
							commentIcon.value = comment.value
							saveComment()
						}
						const pointerDownState: any = {
							x: event.clientX,
							y: event.clientY,
							hitElement: commentIcon,
							hitElementOffsets: {
								x: event.clientX - x,
								y: event.clientY - y
							}
						}
						const onPointerMove = onPointerMoveFromPointerDownHandler(
							pointerDownState
						)
						const onPointerUp = onPointerUpFromPointerDownHandler(
							pointerDownState
						)
						window.addEventListener('pointermove', onPointerMove)
						window.addEventListener('pointerup', onPointerUp)

						pointerDownState.onMove = onPointerMove
						pointerDownState.onUp = onPointerUp

						excalidrawAPI?.setActiveTool({
							type: 'custom',
							customType: 'comment'
						})
					}}
				>
					<div className="comment-avatar">
						<img src="doremon.png" alt="doremon" />
					</div>
				</div>
			)
		})
	}

	const renderComment = () => {
		if (!comment) {
			return null
		}
		const appState = excalidrawAPI?.getAppState()!
		const { x, y } = sceneCoordsToViewportCoords(
			{ sceneX: comment.x, sceneY: comment.y },
			appState
		)
		let top = y - COMMENT_ICON_DIMENSION / 2 - appState.offsetTop
		let left = x - COMMENT_ICON_DIMENSION / 2 - appState.offsetLeft

		if (
			top + COMMENT_INPUT_HEIGHT
			< appState.offsetTop + COMMENT_INPUT_HEIGHT
		) {
			top = COMMENT_ICON_DIMENSION / 2
		}
		if (top + COMMENT_INPUT_HEIGHT > appState.height) {
			top = appState.height - COMMENT_INPUT_HEIGHT - COMMENT_ICON_DIMENSION / 2
		}
		if (
			left + COMMENT_INPUT_WIDTH
			< appState.offsetLeft + COMMENT_INPUT_WIDTH
		) {
			left = COMMENT_ICON_DIMENSION / 2
		}
		if (left + COMMENT_INPUT_WIDTH > appState.width) {
			left = appState.width - COMMENT_INPUT_WIDTH - COMMENT_ICON_DIMENSION / 2
		}

		return (
			<textarea
				className="comment"
				style={{
					top: `${top}px`,
					left: `${left}px`,
					position: 'absolute',
					zIndex: 1,
					height: `${COMMENT_INPUT_HEIGHT}px`,
					width: `${COMMENT_INPUT_WIDTH}px`
				}}
				ref={(ref) => {
					setTimeout(() => ref?.focus())
				}}
				placeholder={comment.value ? 'Reply' : 'Comment'}
				value={comment.value}
				onChange={(event) => {
					setComment({ ...comment, value: event.target.value })
				}}
				onBlur={saveComment}
				onKeyDown={(event) => {
					if (!event.shiftKey && event.key === 'Enter') {
						event.preventDefault()
						saveComment()
					}
				}}
			/>
		)
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
