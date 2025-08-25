/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useRef, useEffect, useCallback, memo, type ReactNode, type MouseEvent, type TouchEvent } from 'react'
import { Icon } from '@mdi/react'
import { mdiDrag } from '@mdi/js'

interface Position {
	x: number
	y: number
}

interface DraggableDialogProps {
	children: ReactNode
	initialPosition?: Position
	className?: string
	onPositionChange?: (position: Position) => void
	enableDrag?: boolean
	id: string
}

export const DraggableDialog = memo(function DraggableDialog({
	children,
	initialPosition = { x: 20, y: 20 },
	className = '',
	onPositionChange,
	enableDrag = true,
	id,
}: DraggableDialogProps) {
	const [position, setPosition] = useState<Position>(() => {
		// Try to restore position from localStorage
		const savedPosition = localStorage.getItem(`dialog-position-${id}`)
		if (savedPosition) {
			try {
				return JSON.parse(savedPosition)
			} catch {
				return initialPosition
			}
		}
		return initialPosition
	})

	const [isDragging, setIsDragging] = useState(false)
	const [dragStart, setDragStart] = useState<Position>({ x: 0, y: 0 })
	const dialogRef = useRef<HTMLDivElement>(null)
	const dragHandleRef = useRef<HTMLDivElement>(null)

	// Save position to localStorage when it changes
	useEffect(() => {
		localStorage.setItem(`dialog-position-${id}`, JSON.stringify(position))
		onPositionChange?.(position)
	}, [position, id, onPositionChange])

	// Ensure dialog stays within viewport bounds
	const constrainPosition = useCallback((pos: Position): Position => {
		if (!dialogRef.current) return pos

		const dialog = dialogRef.current
		const rect = dialog.getBoundingClientRect()
		const viewportWidth = window.innerWidth
		const viewportHeight = window.innerHeight

		// Account for sidebars - check for Nextcloud sidebar and Excalidraw library
		const ncSidebar = document.querySelector('.app-sidebar')
		const excalidrawLeftSidebar = document.querySelector('.App-menu__left')
		const excalidrawRightSidebar = document.querySelector('.App-menu__right')

		let leftBound = 10
		let rightBound = viewportWidth - rect.width - 10
		const topBound = 10
		const bottomBound = viewportHeight - rect.height - 10

		// Adjust bounds based on sidebars
		if (excalidrawLeftSidebar && excalidrawLeftSidebar.clientWidth > 0) {
			leftBound = excalidrawLeftSidebar.clientWidth + 10
		}

		if (ncSidebar && !ncSidebar.classList.contains('app-sidebar--hidden')) {
			rightBound = viewportWidth - 300 - rect.width - 10 // Nextcloud sidebar is typically 300px
		} else if (excalidrawRightSidebar && excalidrawRightSidebar.clientWidth > 0) {
			rightBound = viewportWidth - excalidrawRightSidebar.clientWidth - rect.width - 10
		}

		return {
			x: Math.max(leftBound, Math.min(pos.x, rightBound)),
			y: Math.max(topBound, Math.min(pos.y, bottomBound)),
		}
	}, [])

	// Handle mouse down on drag handle
	const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
		if (!enableDrag) return
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(true)
		setDragStart({
			x: e.clientX - position.x,
			y: e.clientY - position.y,
		})
	}, [enableDrag, position])

	// Handle mouse move
	useEffect(() => {
		if (!isDragging) return

		const handleMouseMove = (e: MouseEvent) => {
			e.preventDefault()
			const newPosition = constrainPosition({
				x: e.clientX - dragStart.x,
				y: e.clientY - dragStart.y,
			})
			setPosition(newPosition)
		}

		const handleMouseUp = () => {
			setIsDragging(false)
		}

		document.addEventListener('mousemove', handleMouseMove)
		document.addEventListener('mouseup', handleMouseUp)

		return () => {
			document.removeEventListener('mousemove', handleMouseMove)
			document.removeEventListener('mouseup', handleMouseUp)
		}
	}, [isDragging, dragStart, constrainPosition])

	// Handle touch events for mobile
	const handleTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
		if (!enableDrag) return
		e.preventDefault()
		e.stopPropagation()
		const touch = e.touches[0]
		setIsDragging(true)
		setDragStart({
			x: touch.clientX - position.x,
			y: touch.clientY - position.y,
		})
	}, [enableDrag, position])

	useEffect(() => {
		if (!isDragging) return

		const handleTouchMove = (e: TouchEvent) => {
			e.preventDefault()
			const touch = e.touches[0]
			const newPosition = constrainPosition({
				x: touch.clientX - dragStart.x,
				y: touch.clientY - dragStart.y,
			})
			setPosition(newPosition)
		}

		const handleTouchEnd = () => {
			setIsDragging(false)
		}

		document.addEventListener('touchmove', handleTouchMove, { passive: false })
		document.addEventListener('touchend', handleTouchEnd)

		return () => {
			document.removeEventListener('touchmove', handleTouchMove)
			document.removeEventListener('touchend', handleTouchEnd)
		}
	}, [isDragging, dragStart, constrainPosition])

	// Reposition dialog when sidebars open/close
	useEffect(() => {
		const checkPosition = () => {
			setPosition(prev => constrainPosition(prev))
		}

		// Set up observers for sidebar changes
		const observer = new MutationObserver(checkPosition)

		const ncSidebar = document.querySelector('.app-sidebar')
		if (ncSidebar) {
			observer.observe(ncSidebar, {
				attributes: true,
				attributeFilter: ['class'],
			})
		}

		const excalidrawLeftSidebar = document.querySelector('.App-menu__left')
		if (excalidrawLeftSidebar) {
			observer.observe(excalidrawLeftSidebar, {
				attributes: true,
				childList: true,
				subtree: true,
			})
		}

		window.addEventListener('resize', checkPosition)

		return () => {
			observer.disconnect()
			window.removeEventListener('resize', checkPosition)
		}
	}, [constrainPosition])

	return (
		<div
			ref={dialogRef}
			className={`draggable-dialog ${className} ${isDragging ? 'dragging' : ''}`}
			style={{
				position: 'fixed',
				left: `${position.x}px`,
				top: `${position.y}px`,
				zIndex: isDragging ? 100020 : 100010,
				pointerEvents: 'auto',
			}}
		>
			{enableDrag && (
				<div
					ref={dragHandleRef}
					className="draggable-dialog__handle"
					onMouseDown={handleMouseDown}
					onTouchStart={handleTouchStart}
					title="Drag to move"
				>
					<Icon path={mdiDrag} size={0.8} />
				</div>
			)}
			<div className="draggable-dialog__content">
				{children}
			</div>
		</div>
	)
})
