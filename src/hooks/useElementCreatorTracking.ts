/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useRef } from 'react'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { useJWTStore } from '../stores/useJwtStore'
import type { ElementCreatorInfo, WhiteboardElement } from '../types/whiteboard'

interface UseElementCreatorTrackingProps {
	excalidrawAPI: ExcalidrawImperativeAPI | null
	enabled?: boolean
}

export function useElementCreatorTracking({ excalidrawAPI, enabled = true }: UseElementCreatorTrackingProps) {
	const lastElementsRef = useRef<string[]>([])
	const currentUserInfoRef = useRef<ElementCreatorInfo | null>(null)

	// Get current user info from JWT
	const updateCurrentUserInfo = useCallback(async () => {
		try {
			const jwt = await useJWTStore.getState().getJWT()
			if (jwt) {
				const payload = useJWTStore.getState().parseJwt(jwt)
				if (payload?.user) {
					currentUserInfoRef.current = {
						id: payload.user.id,
						name: payload.user.name,
						createdAt: Date.now(),
					}
				}
			}
		} catch (error) {
			console.error('[CreatorTracking] Failed to get user info:', error)
		}
	}, [])

	// Add creator info to new elements
	const addCreatorInfo = useCallback((element: ExcalidrawElement): WhiteboardElement => {
		if (!currentUserInfoRef.current || !enabled) {
			return element as WhiteboardElement
		}

		const whiteboardElement = element as WhiteboardElement

		// Initialize customData if it doesn't exist
		if (!whiteboardElement.customData) {
			whiteboardElement.customData = {}
		}

		// Add creator info if not already present
		if (!whiteboardElement.customData.creator) {
			whiteboardElement.customData.creator = { ...currentUserInfoRef.current }
		}

		// Update last modified by
		whiteboardElement.customData.lastModifiedBy = {
			...currentUserInfoRef.current,
			createdAt: Date.now(),
		}

		return whiteboardElement
	}, [enabled])

	// Process elements to add creator info
	const processElements = useCallback((elements: readonly ExcalidrawElement[]): WhiteboardElement[] => {
		if (!enabled || !currentUserInfoRef.current) {
			return elements as WhiteboardElement[]
		}

		const currentElementIds = elements.map(el => el.id)
		const newElementIds = currentElementIds.filter(id => !lastElementsRef.current.includes(id))

		const processedElements = elements.map(element => {
			// If it's a new element, add creator info
			if (newElementIds.includes(element.id)) {
				return addCreatorInfo(element)
			}

			// If element was modified (version changed), update lastModifiedBy
			const existingElement = elements.find(el => el.id === element.id)
			if (existingElement && element.versionNonce !== existingElement.versionNonce) {
				const whiteboardElement = element as WhiteboardElement
				if (!whiteboardElement.customData) {
					whiteboardElement.customData = {}
				}
				whiteboardElement.customData.lastModifiedBy = {
					...currentUserInfoRef.current,
					createdAt: Date.now(),
				}
				return whiteboardElement
			}

			return element as WhiteboardElement
		})

		lastElementsRef.current = currentElementIds
		return processedElements
	}, [enabled, addCreatorInfo])

	// Monitor element changes
	useEffect(() => {
		if (!excalidrawAPI || !enabled) return

		// Initialize user info on mount
		updateCurrentUserInfo()

		const handleChange = () => {
			const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
			const needsUpdate: WhiteboardElement[] = []

			elements.forEach(element => {
				const whiteboardElement = element as WhiteboardElement

				// Check if element needs creator info
				if (!whiteboardElement.isDeleted && !whiteboardElement.customData?.creator && currentUserInfoRef.current) {
					// This is a new element without creator info
					const updatedElement = { ...whiteboardElement }
					if (!updatedElement.customData) {
						updatedElement.customData = {}
					}
					updatedElement.customData.creator = {
						...currentUserInfoRef.current,
						createdAt: Date.now(),
					}
					updatedElement.customData.lastModifiedBy = {
						...currentUserInfoRef.current,
						createdAt: Date.now(),
					}
					needsUpdate.push(updatedElement)
				}
			})

			if (needsUpdate.length > 0) {
				// Update only the elements that need creator info
				const allElements = elements.map(el => {
					const updated = needsUpdate.find(u => u.id === el.id)
					return updated || el
				})

				excalidrawAPI.updateScene({
					elements: allElements.filter(el => !el.isDeleted) as NonDeletedExcalidrawElement[],
				})
			}
		}

		// Subscribe to element changes
		const unsubscribe = excalidrawAPI.onChange(handleChange)

		return () => {
			if (unsubscribe) {
				unsubscribe()
			}
		}
	}, [excalidrawAPI, enabled, processElements, updateCurrentUserInfo])

	// Get creator info for a specific element
	const getElementCreatorInfo = useCallback((elementId: string): ElementCreatorInfo | null => {
		if (!excalidrawAPI) return null

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as WhiteboardElement[]
		const element = elements.find(el => el.id === elementId)

		return element?.customData?.creator || null
	}, [excalidrawAPI])

	// Get all unique creators in the current board
	const getAllCreators = useCallback((): Map<string, ElementCreatorInfo> => {
		if (!excalidrawAPI) return new Map()

		const creators = new Map<string, ElementCreatorInfo>()
		const elements = excalidrawAPI.getSceneElementsIncludingDeleted() as WhiteboardElement[]

		elements.forEach(element => {
			if (element.customData?.creator) {
				creators.set(element.customData.creator.id, element.customData.creator)
			}
			if (element.customData?.lastModifiedBy) {
				creators.set(element.customData.lastModifiedBy.id, element.customData.lastModifiedBy)
			}
		})

		return creators
	}, [excalidrawAPI])

	return {
		getElementCreatorInfo,
		getAllCreators,
		processElements,
		addCreatorInfo,
	}
}
