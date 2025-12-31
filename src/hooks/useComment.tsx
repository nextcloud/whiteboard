/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { mdiCommentOutline, mdiAccount } from '@mdi/js'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import { useShallow } from 'zustand/react/shallow'
import { viewportCoordsToSceneCoords, convertToExcalidrawElements } from '@nextcloud/excalidraw'
import { generateUrl } from '@nextcloud/router'
import { getCurrentUser } from '@nextcloud/auth'
import { CommentPopover } from '../components/CommentPopover'
import { renderToolbarButton } from '../components/ToolbarButton'
import { getRelativeTime } from '../utils/time'
import './useComment.scss'

export interface Comment {
	id: string
	author: string
	userId: string
	text: string
	created: number
}

export interface CommentThread {
	id: string
	x: number
	y: number
	comments: Comment[]
}

interface UseCommentProps {
	onCommentThreadClick?: (commentThreadId: string | null) => void
	activeCommentThreadId?: string | null
	onOpenSidebar?: () => void
	isReadOnly?: boolean
}

interface DragState {
	isDragging: boolean
	startX: number
	startY: number
}

interface CommentElementData {
	customData: {
		type: string
		commentThread: CommentThread
	}
	isDeleted: boolean
	x: number
	y: number
}

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function isCommentElement(element: unknown): element is CommentElementData {
	if (typeof element !== 'object' || element === null) return false
	const el = element as Record<string, unknown>

	if (!el.customData || typeof el.customData !== 'object') return false
	const customData = el.customData as Record<string, unknown>

	return customData.type === 'comment'
		&& !el.isDeleted
		&& typeof customData.commentThread === 'object'
}

function createFallbackIcon(): SVGSVGElement {
	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	icon.setAttribute('width', '32')
	icon.setAttribute('height', '32')
	icon.setAttribute('viewBox', '0 0 24 24')

	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
	path.setAttribute('d', mdiAccount)
	path.setAttribute('fill', 'white')

	icon.appendChild(path)
	return icon
}

function calculateSceneCoordinates(
	clientX: number,
	clientY: number,
	containerRect: DOMRect,
	offsetX: number,
	offsetY: number,
	viewport: { zoom: { value: number }, scrollX: number, scrollY: number },
): { canvasX: number, canvasY: number, sceneX: number, sceneY: number } {
	const canvasX = clientX - containerRect.left - offsetX
	const canvasY = clientY - containerRect.top - offsetY

	const sceneX = (canvasX / viewport.zoom.value) - viewport.scrollX
	const sceneY = (canvasY / viewport.zoom.value) - viewport.scrollY

	return { canvasX, canvasY, sceneX, sceneY }
}

function createDragStateManager() {
	let isDragging = false
	let startX = 0
	let startY = 0

	return {
		start: (x: number, y: number) => {
			isDragging = false
			startX = x
			startY = y
		},
		checkThreshold: (currentX: number, currentY: number, threshold = 3): boolean => {
			if (isDragging) return true

			const deltaX = Math.abs(currentX - startX)
			const deltaY = Math.abs(currentY - startY)

			if (deltaX > threshold || deltaY > threshold) {
				isDragging = true
				return true
			}
			return false
		},
		isDragging: () => isDragging,
		reset: () => { isDragging = false },
	}
}

function createClickDragDetector(delayMs = 100) {
	let wasDragging = false
	let timeoutId: number | null = null

	return {
		markAsDragging: () => {
			wasDragging = true
			if (timeoutId) clearTimeout(timeoutId)
			timeoutId = window.setTimeout(() => {
				wasDragging = false
			}, delayMs)
		},
		wasRecentlyDragging: () => wasDragging,
		cleanup: () => {
			if (timeoutId) clearTimeout(timeoutId)
		},
	}
}

function updatePinPosition(
	pin: HTMLElement,
	thread: CommentThread,
	viewport: { zoom: { value: number }, scrollX: number, scrollY: number },
) {
	const x = (thread.x + viewport.scrollX) * viewport.zoom.value
	const y = (thread.y + viewport.scrollY) * viewport.zoom.value

	pin.style.left = `${x}px`
	pin.style.top = `${y}px`
}

function createPinElement(
	thread: CommentThread,
	isActive: boolean,
	viewport: { zoom: { value: number }, scrollX: number, scrollY: number },
): HTMLElement {
	const x = (thread.x + viewport.scrollX) * viewport.zoom.value
	const y = (thread.y + viewport.scrollY) * viewport.zoom.value

	const pin = document.createElement('div')
	pin.className = `comment-pin ${isActive ? 'active' : ''}`
	pin.dataset.commentThreadId = thread.id
	pin.style.left = `${x}px`
	pin.style.top = `${y}px`

	const avatar = document.createElement('div')
	avatar.className = 'comment-pin__avatar'

	const firstComment = thread.comments[0]
	const userId = firstComment?.userId || getCurrentUser()?.uid
	const replyCount = thread.comments.length - 1

	if (userId) {
		avatar.style.backgroundImage = `url('${generateUrl(`/avatar/${userId}/64/dark`)}')`
	} else {
		avatar.appendChild(createFallbackIcon())
	}

	if (replyCount > 0) {
		const badge = document.createElement('span')
		badge.className = 'comment-pin__count'
		badge.textContent = String(replyCount)
		avatar.appendChild(badge)
	}

	pin.appendChild(avatar)

	if (firstComment) {
		const preview = document.createElement('div')
		preview.className = 'comment-pin__preview'

		const header = document.createElement('div')
		header.className = 'comment-pin__preview-header'

		const author = document.createElement('strong')
		author.className = 'comment-pin__preview-author'
		author.textContent = firstComment.author
		header.appendChild(author)

		const time = document.createElement('time')
		time.className = 'comment-pin__preview-time'
		time.textContent = getRelativeTime(firstComment.created)
		header.appendChild(time)

		preview.appendChild(header)

		const text = document.createElement('div')
		text.className = 'comment-pin__preview-text'
		text.textContent = firstComment.text
		preview.appendChild(text)

		if (replyCount > 0) {
			const replies = document.createElement('div')
			replies.className = 'comment-pin__preview-replies'
			replies.textContent = `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
			preview.appendChild(replies)
		}

		pin.appendChild(preview)
	}

	return pin
}

export function useComment(props?: UseCommentProps) {
	const { onCommentThreadClick, activeCommentThreadId, isReadOnly } = props || {}
	const [isPlacingComment, setIsPlacingComment] = useState(false)
	const [pendingThread, setPendingThread] = useState<{ id: string, x: number, y: number } | null>(null)

	const dragStateRef = useRef<DragState | null>(null)
	const popoverRenderRef = useRef<(() => void) | null>(null)
	const onThreadClickRef = useRef(onCommentThreadClick)

	const { excalidrawAPI } = useExcalidrawStore(
		useShallow(state => ({ excalidrawAPI: state.excalidrawAPI })),
	)

	useEffect(() => {
		onThreadClickRef.current = onCommentThreadClick
	}, [onCommentThreadClick])

	const getAllThreads = useCallback((): CommentThread[] => {
		if (!excalidrawAPI) return []

		return excalidrawAPI
			.getSceneElementsIncludingDeleted()
			.filter(isCommentElement)
			.map((el: CommentElementData) => ({
				id: el.customData.commentThread.id,
				x: el.x,
				y: el.y,
				comments: el.customData.commentThread.comments || [],
			}))
	}, [excalidrawAPI])

	const [commentThreads, setCommentThreads] = useState<CommentThread[]>([])

	useEffect(() => {
		if (!excalidrawAPI) return

		const hasThreadsChanged = (prev: CommentThread[], next: CommentThread[]): boolean => {
			if (prev.length !== next.length) return true

			return prev.some((thread, index) => {
				const nextThread = next[index]
				if (!nextThread || thread.id !== nextThread.id) return true
				if (thread.comments.length !== nextThread.comments.length) return true

				return thread.comments.some((comment, commentIndex) => {
					const nextComment = nextThread.comments[commentIndex]
					return comment.id !== nextComment?.id || comment.text !== nextComment?.text
				})
			})
		}

		const refreshThreads = () => {
			const newThreads = getAllThreads()
			setCommentThreads(prevThreads =>
				hasThreadsChanged(prevThreads, newThreads) ? newThreads : prevThreads,
			)
		}

		refreshThreads()
		const unsubscribe = excalidrawAPI.onChange?.(refreshThreads)

		return () => unsubscribe?.()
	}, [excalidrawAPI, getAllThreads])

	const deleteThread = useCallback((threadId: string) => {
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
		const updatedElements = elements.map((el: unknown) =>
			isCommentElement(el) && el.customData?.commentThread?.id === threadId
				? { ...el, isDeleted: true }
				: el,
		)

		excalidrawAPI.updateScene({ elements: updatedElements })
	}, [excalidrawAPI])

	const cleanupEmptyThreads = useCallback(() => {
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
		const emptyThreadIds = elements
			.filter((el: unknown) => isCommentElement(el) && el.customData.commentThread.comments.length === 0)
			.map((el: unknown) => isCommentElement(el) ? el.customData.commentThread.id : '')
			.filter(Boolean)

		emptyThreadIds.forEach((threadId: string) => deleteThread(threadId))
	}, [excalidrawAPI, deleteThread])

	const updateThread = useCallback((threadId: string, updater: (thread: CommentThread) => Partial<Record<string, unknown>>) => {
		if (!excalidrawAPI) return

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
		const updatedElements = elements.map((el: unknown) => {
			if (isCommentElement(el) && el.customData?.commentThread?.id === threadId) {
				return {
					...el,
					...updater(el.customData.commentThread),
				}
			}
			return el
		})

		excalidrawAPI.updateScene({ elements: updatedElements })
	}, [excalidrawAPI])

	const updateThreadPosition = useCallback((threadId: string, x: number, y: number) => {
		if (pendingThread?.id === threadId) {
			setPendingThread({ id: threadId, x, y })
		} else {
			updateThread(threadId, () => ({ x, y }))
		}
	}, [updateThread, pendingThread])

	const setupPinClickHandler = useCallback((pin: HTMLElement, threadId: string) => {
		const clickDetector = createClickDragDetector()

		const handleClick = (e: MouseEvent) => {
			if (clickDetector.wasRecentlyDragging()) {
				e.stopPropagation()
				return
			}
			e.stopPropagation()
			const newThreadId = activeCommentThreadId === threadId ? null : threadId
			onThreadClickRef.current?.(newThreadId)
		}

		pin.addEventListener('click', handleClick)

		return {
			cleanup: () => clickDetector.cleanup(),
			markAsDragging: () => clickDetector.markAsDragging(),
		}
	}, [activeCommentThreadId])

	const setupPinDragHandlers = useCallback((pin: HTMLElement, threadId: string, clickDetector: {
		cleanup: () => void;
		markAsDragging: () => void
	}) => {
		if (!excalidrawAPI || isReadOnly) return

		const dragState = createDragStateManager()
		let finalSceneX = 0
		let finalSceneY = 0
		let containerRect: DOMRect | null = null
		let offsetX = 0
		let offsetY = 0

		const handlePointerMove = (e: PointerEvent) => {
			if (!dragStateRef.current) return

			const dragStarted = dragState.checkThreshold(e.clientX, e.clientY)

			if (dragStarted && !dragStateRef.current.isDragging) {
				dragStateRef.current.isDragging = true
				pin.classList.add('dragging')
			}

			if (dragState.isDragging()) {
				e.preventDefault()
				if (!containerRect) return

				const viewport = excalidrawAPI.getAppState()
				const coords = calculateSceneCoordinates(
					e.clientX,
					e.clientY,
					containerRect,
					offsetX,
					offsetY,
					viewport,
				)

				pin.style.left = `${coords.canvasX}px`
				pin.style.top = `${coords.canvasY}px`

				finalSceneX = coords.sceneX
				finalSceneY = coords.sceneY

				if (activeCommentThreadId === threadId && popoverRenderRef.current) {
					popoverRenderRef.current()
				}
			}
		}

		const handlePointerEnd = () => {
			pin.style.cursor = 'grab'
			pin.classList.remove('dragging')
			document.removeEventListener('pointermove', handlePointerMove)
			document.removeEventListener('pointerup', handlePointerEnd)
			document.removeEventListener('pointercancel', handlePointerEnd)

			if (dragStateRef.current?.isDragging) {
				clickDetector.markAsDragging()
				updateThreadPosition(threadId, finalSceneX, finalSceneY)
			}

			dragStateRef.current = null
			containerRect = null
			dragState.reset()
		}

		const handlePointerStart = (e: PointerEvent) => {
			e.preventDefault()
			e.stopPropagation()

			containerRect = pin.parentElement?.getBoundingClientRect() || null

			if (containerRect) {
				const currentLeft = parseFloat(pin.style.left)
				const currentTop = parseFloat(pin.style.top)

				offsetX = e.clientX - (containerRect.left + currentLeft)
				offsetY = e.clientY - (containerRect.top + currentTop)
			}

			dragState.start(e.clientX, e.clientY)
			dragStateRef.current = {
				isDragging: false,
				startX: e.clientX,
				startY: e.clientY,
			}

			pin.style.cursor = 'grabbing'
			document.addEventListener('pointermove', handlePointerMove)
			document.addEventListener('pointerup', handlePointerEnd)
			document.addEventListener('pointercancel', handlePointerEnd)
		}

		pin.addEventListener('pointerdown', handlePointerStart)
	}, [excalidrawAPI, updateThreadPosition, activeCommentThreadId, isReadOnly])

	const setupPinInteractions = useCallback((pin: HTMLElement, threadId: string) => {
		const clickHandler = setupPinClickHandler(pin, threadId)
		setupPinDragHandlers(pin, threadId, clickHandler)

		return () => {
			clickHandler.cleanup()
		}
	}, [setupPinClickHandler, setupPinDragHandlers])

	const renderCommentPins = useCallback(() => {
		if (!excalidrawAPI || dragStateRef.current) return

		const threads = getAllThreads()
		const canvasElement = document.querySelector('.excalidraw')
		if (!canvasElement) {
			console.warn('[Comment] Canvas element not found, skipping pin render')
			return
		}

		let pinsContainer = document.querySelector('.comment-pins-container') as HTMLElement

		if (threads.length === 0 && !pendingThread) {
			pinsContainer?.remove()
			return
		}

		if (!pinsContainer) {
			pinsContainer = document.createElement('div')
			pinsContainer.className = 'comment-pins-container'
			canvasElement.appendChild(pinsContainer)
		}

		const viewport = excalidrawAPI.getAppState()
		const existingPins = new Map<string, HTMLElement>()

		pinsContainer.querySelectorAll('.comment-pin').forEach((pin: Element) => {
			const htmlPin = pin as HTMLElement
			const id = htmlPin.dataset.commentThreadId
			if (id) existingPins.set(id, htmlPin)
		})

		const processedIds = new Set<string>()

		threads.forEach((thread: CommentThread) => {
			processedIds.add(thread.id)
			const existingPin = existingPins.get(thread.id)
			const isActive = activeCommentThreadId === thread.id

			if (existingPin) {
				updatePinPosition(existingPin, thread, viewport)
				existingPin.className = `comment-pin ${isActive ? 'active' : ''}`
			} else {
				const pin = createPinElement(thread, isActive, viewport)
				setupPinInteractions(pin, thread.id)
				pinsContainer.appendChild(pin)
			}
		})

		if (pendingThread) {
			processedIds.add(pendingThread.id)
			const existingPin = existingPins.get(pendingThread.id)
			const isActive = activeCommentThreadId === pendingThread.id

			if (existingPin) {
				updatePinPosition(existingPin, { ...pendingThread, comments: [] }, viewport)
				existingPin.className = `comment-pin ${isActive ? 'active' : ''}`
			} else {
				const pendingPin = createPinElement(
					{ ...pendingThread, comments: [] },
					isActive,
					viewport,
				)

				setupPinInteractions(pendingPin, pendingThread.id)
				pinsContainer.appendChild(pendingPin)
			}
		}

		existingPins.forEach((pin: HTMLElement, id: string) => {
			if (!processedIds.has(id)) {
				pin.remove()
			}
		})
	}, [excalidrawAPI, getAllThreads, activeCommentThreadId, setupPinInteractions, pendingThread])

	useEffect(() => {
		if (!excalidrawAPI) return

		renderCommentPins()
		const unsubscribe = excalidrawAPI.onChange?.(renderCommentPins)

		return () => {
			unsubscribe?.()
			document.querySelector('.comment-pins-container')?.remove()
		}
	}, [excalidrawAPI, renderCommentPins])

	useEffect(() => {
		if (!isPlacingComment || !excalidrawAPI) return

		const canvasElement = document.querySelector('.excalidraw') as HTMLElement
		if (!canvasElement) {
			console.warn('[Comment] Canvas element not found')
			setIsPlacingComment(false)
			return
		}

		canvasElement.style.cursor = 'crosshair'

		const handleCanvasClick = (e: PointerEvent) => {
			const target = e.target as HTMLElement

			if (!target.classList.contains('excalidraw__canvas') && !target.closest('.comment-trigger')) {
				setIsPlacingComment(false)
				if (canvasElement) canvasElement.style.cursor = ''
				return
			}

			if (!target.classList.contains('excalidraw__canvas')) {
				return
			}

			try {
				const sceneCoords = viewportCoordsToSceneCoords(
					{ clientX: e.clientX, clientY: e.clientY },
					excalidrawAPI.getAppState(),
				)

				const newThreadId = generateId()
				setPendingThread({ id: newThreadId, x: sceneCoords.x, y: sceneCoords.y })

				if (canvasElement) canvasElement.style.cursor = ''
				setIsPlacingComment(false)

				onCommentThreadClick?.(newThreadId)
			} catch (error) {
				console.error('[Comment] Failed to place comment:', error)
				setIsPlacingComment(false)
				canvasElement.style.cursor = ''
			}
		}

		document.addEventListener('click', handleCanvasClick)

		return () => {
			document.removeEventListener('click', handleCanvasClick)
			if (canvasElement) canvasElement.style.cursor = ''
		}
	}, [isPlacingComment, excalidrawAPI, onCommentThreadClick])

	useEffect(() => {
		if (!activeCommentThreadId || !excalidrawAPI) return

		const canvasElement = document.querySelector('.excalidraw')
		let pinElement = document.querySelector(`[data-comment-thread-id="${activeCommentThreadId}"]`)

		if (!pinElement && pendingThread?.id === activeCommentThreadId) {
			renderCommentPins()
			pinElement = document.querySelector(`[data-comment-thread-id="${activeCommentThreadId}"]`)
		}

		if (!canvasElement || !pinElement) return

		const handleSubmitComment = (text: string) => {

			if (!text || !text.trim()) {
				console.warn('[Comment] Cannot submit empty comment')
				return
			}

			if (!activeCommentThreadId) {
				console.warn('[Comment] Cannot submit comment: no active thread')
				return
			}

			try {
				const user = getCurrentUser()
				const newComment: Comment = {
					id: generateId(),
					author: user?.displayName || 'Guest',
					userId: user?.uid || '',
					text,
					created: Date.now(),
				}

				if (pendingThread?.id === activeCommentThreadId) {
					const newThreadElement = convertToExcalidrawElements([{
						type: 'ellipse',
						x: pendingThread.x,
						y: pendingThread.y,
						width: 1,
						height: 1,
						opacity: 0,
						locked: true,
						customData: {
							type: 'comment',
							commentThread: {
								id: pendingThread.id,
								comments: [newComment],
							},
						},
					}])

					excalidrawAPI.updateScene({
						elements: [...excalidrawAPI.getSceneElements(), ...newThreadElement],
					})

					setPendingThread(null)
				} else {
					updateThread(activeCommentThreadId, (thread: CommentThread) => ({
						customData: {
							type: 'comment',
							commentThread: {
								...thread,
								comments: [...thread.comments, newComment],
							},
						},
					}))
				}
			} catch (error) {
				console.error('[Comment] Failed to submit comment:', error)
			}
		}

		const handleEditComment = (commentId: string, text: string) => {
			try {
				updateThread(activeCommentThreadId, (thread: CommentThread) => ({
					customData: {
						type: 'comment',
						commentThread: {
							...thread,
							comments: thread.comments.map((comment: Comment) =>
								comment.id === commentId ? { ...comment, text } : comment,
							),
						},
					},
				}))
			} catch (error) {
				console.error('[Comment] Failed to edit comment:', error)
			}
		}

		const handleDeleteThread = () => {
			try {
				deleteThread(activeCommentThreadId)
				onThreadClickRef.current?.(null)
			} catch (error) {
				console.error('[Comment] Failed to delete thread:', error)
			}
		}

		const popoverContainer = document.createElement('div')
		popoverContainer.className = 'comment-popover-container'
		canvasElement.appendChild(popoverContainer)

		const root = createRoot(popoverContainer)

		const renderPopover = () => {
			const currentPin = document.querySelector(`[data-comment-thread-id="${activeCommentThreadId}"]`)
			if (!currentPin) return

			const pinRect = currentPin.getBoundingClientRect()
			const thread = getAllThreads().find((t: CommentThread) => t.id === activeCommentThreadId)
			const threadData = thread || (pendingThread?.id === activeCommentThreadId ? { ...pendingThread, comments: [] } : null)

			root.render(
				<CommentPopover
					key={activeCommentThreadId}
					x={pinRect.right}
					y={pinRect.top + (pinRect.height / 2)}
					commentThread={threadData}
					isReadOnly={isReadOnly}
					onClose={() => onThreadClickRef.current?.(null)}
					onSubmitComment={handleSubmitComment}
					onEditComment={handleEditComment}
					onDeleteThread={handleDeleteThread}
				/>,
			)
		}

		popoverRenderRef.current = renderPopover
		renderPopover()

		const unsubscribe = excalidrawAPI.onChange?.(renderPopover)

		return () => {
			unsubscribe?.()
			root.unmount()
			popoverContainer.remove()
			popoverRenderRef.current = null
		}
	}, [activeCommentThreadId, getAllThreads, excalidrawAPI, updateThread, deleteThread, pendingThread, renderCommentPins, isReadOnly])

	useEffect(() => {
		const handleClickOutsidePopover = (e: MouseEvent) => {
			const target = e.target as HTMLElement
			if (target.closest('.comment-pin, .comment-popover')) return

			if (activeCommentThreadId) {
				if (pendingThread?.id === activeCommentThreadId) {
					setPendingThread(null)
				}
				onCommentThreadClick?.(null)
				setTimeout(cleanupEmptyThreads, 0)
			}
		}

		document.addEventListener('pointerdown', handleClickOutsidePopover)
		return () => document.removeEventListener('pointerdown', handleClickOutsidePopover)
	}, [activeCommentThreadId, onCommentThreadClick, cleanupEmptyThreads, pendingThread])

	const renderComment = useCallback(() => {
		renderToolbarButton({
			class: 'comment-container',
			buttonClass: 'comment-trigger',
			icon: mdiCommentOutline,
			label: 'Add comment',
			onClick: () => {
				setIsPlacingComment(true)
				props?.onOpenSidebar?.()
			},
		})
	}, [props])

	const panToThread = useCallback((threadId: string) => {
		if (!excalidrawAPI) return

		const thread = getAllThreads().find((t: CommentThread) => t.id === threadId)
		if (!thread) return

		const appState = excalidrawAPI.getAppState()
		const zoom = appState.zoom.value

		const layerWrapper = document.querySelector('.layer-ui__wrapper') as HTMLElement
		const layerWidth = layerWrapper?.offsetWidth || window.innerWidth
		const layerHeight = window.innerHeight

		excalidrawAPI.updateScene({
			appState: {
				scrollX: -thread.x + (layerWidth / 2) / zoom,
				scrollY: -thread.y + (layerHeight / 2) / zoom,
			},
		})

		onCommentThreadClick?.(threadId)
	}, [excalidrawAPI, getAllThreads, onCommentThreadClick])

	return {
		commentThreads,
		renderComment,
		panToThread,
		deleteThread,
	}
}
