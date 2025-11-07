/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import type { ExcalidrawImperativeAPI } from '@nextcloud/excalidraw/dist/types/excalidraw/types'
import type { CreatorDisplaySettings, WhiteboardElement } from '../types/whiteboard'
import styles from './CreatorDisplay.module.scss'
import { sceneCoordsToViewportCoords } from '@nextcloud/excalidraw'

interface CreatorDisplayProps {
	excalidrawAPI: ExcalidrawImperativeAPI | null
	settings: CreatorDisplaySettings
}

interface CreatorLabel {
	elementId: string
	creatorName: string
	x: number
	y: number
	isSelected: boolean
}

export const CreatorDisplay = ({ excalidrawAPI, settings }: CreatorDisplayProps) => {
	const [creatorLabels, setCreatorLabels] = useState<CreatorLabel[]>([])
	const [hoveredElementId, setHoveredElementId] = useState<string | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)

	// Calculate label position for an element
	const getElementBounds = useCallback((element: WhiteboardElement) => {
		if (!excalidrawAPI) return null

		const appState = excalidrawAPI.getAppState()

		let widthAddend
		let heightAddend = 0
		if (element.points && element.points[1]) {
			widthAddend = element.points[1][0] / 2
			heightAddend = element.points[1][1] / 2
		} else {
			widthAddend = element.width / 2
		}

		const { sceneX, sceneY } = { sceneX: element.x + widthAddend, sceneY: element.y + heightAddend }

		const { x, y } = sceneCoordsToViewportCoords({ sceneX, sceneY }, appState)

		return { x, y: y - 73 }
	}, [excalidrawAPI])

	// Update creator labels based on current scene
	const updateCreatorLabels = useCallback(() => {
		if (!excalidrawAPI || !settings.enabled) {
			setCreatorLabels([])
			return
		}

		const elements = excalidrawAPI.getSceneElements() as WhiteboardElement[]
		const selectedElementIds = excalidrawAPI.getAppState().selectedElementIds
		const labels: CreatorLabel[] = []

		elements.forEach(element => {
			if (!element.customData?.creator) return

			const shouldDisplay
				= settings.displayMode === 'always'
				|| (settings.displayMode === 'selection' && selectedElementIds[element.id])
				|| (settings.displayMode === 'hover' && hoveredElementId === element.id)

			if (shouldDisplay) {
				const bounds = getElementBounds(element)
				if (bounds) {
					labels.push({
						elementId: element.id,
						creatorName: element.customData.creator.displayName,
						x: bounds.x,
						y: bounds.y,
						isSelected: !!selectedElementIds[element.id],
					})
				}
			}
		})

		setCreatorLabels(labels)
	}, [excalidrawAPI, settings, hoveredElementId, getElementBounds])

	// Handle mouse move for hover detection
	const handleMouseMove = useCallback((event: MouseEvent) => {
		if (!excalidrawAPI || settings.displayMode !== 'hover') return

		// Get the canvas element
		const canvas = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement
		if (!canvas) return

		// Get canvas bounding rect
		const rect = canvas.getBoundingClientRect()
		const x = event.clientX - rect.left
		const y = event.clientY - rect.top

		// Get app state for coordinate conversion
		const appState = excalidrawAPI.getAppState()

		// Convert to scene coordinates
		const sceneX = (x - appState.scrollX) / appState.zoom.value
		const sceneY = (y - appState.scrollY) / appState.zoom.value

		// Get all elements and check hit detection
		const elements = excalidrawAPI.getSceneElements() as WhiteboardElement[]

		// Find element under cursor with some padding for easier detection
		const HOVER_PADDING = 10 // Add padding for easier hover
		let foundElement: WhiteboardElement | null = null

		for (let i = elements.length - 1; i >= 0; i--) {
			const element = elements[i]

			// Calculate element bounds with padding
			const minX = element.x - HOVER_PADDING
			const maxX = element.x + element.width + HOVER_PADDING
			const minY = element.y - HOVER_PADDING
			const maxY = element.y + element.height + HOVER_PADDING

			if (
				sceneX >= minX
				&& sceneX <= maxX
				&& sceneY >= minY
				&& sceneY <= maxY
			) {
				// For better accuracy, also check if element has creator info
				if (element.customData?.creator) {
					foundElement = element
					break
				}
			}
		}

		setHoveredElementId(foundElement?.id || null)
	}, [excalidrawAPI, settings.displayMode])

	// Subscribe to Excalidraw changes
	useEffect(() => {
		if (!excalidrawAPI) return

		const unsubscribe = excalidrawAPI.onChange(updateCreatorLabels)

		// Initial update
		updateCreatorLabels()

		return () => {
			if (unsubscribe) {
				unsubscribe()
			}
		}
	}, [excalidrawAPI, updateCreatorLabels])

	// Add mouse move listener for hover mode
	useEffect(() => {
		if (settings.displayMode === 'hover') {
			document.addEventListener('mousemove', handleMouseMove)
			return () => {
				document.removeEventListener('mousemove', handleMouseMove)
			}
		}
	}, [settings.displayMode, handleMouseMove])

	// Memoize label style
	const labelStyle = useMemo(() => ({
		opacity: settings.opacity,
	}), [settings.opacity])

	if (!settings.enabled || creatorLabels.length === 0) {
		return null
	}

	return (
		<div ref={containerRef} className={styles.overlay}>
			{creatorLabels.map(label => (
				<div
					key={label.elementId}
					className={styles.label}
					style={{
						...labelStyle,
						left: `${label.x}px`,
						top: `${label.y}px`,
					}}
					data-selected={label.isSelected}
				>
					<span className={styles.name}>{label.creatorName}</span>
				</div>
			))}
		</div>
	)
}
