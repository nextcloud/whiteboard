/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

interface JWTState {
	tokens: Record<string, string>

	getJWT: (
		roomId: string,
		publicSharingToken: string | null,
	) => Promise<string | null>
	refreshJWT: (
		roomId: string,
		publicSharingToken: string | null,
	) => Promise<string | null>
	clearJWT: (roomId: string) => void
	clearAllJWT: () => void
}

export const useJWTStore = create<JWTState>()(
	persist(
		(set, get) => ({
			tokens: {},

			getJWT: async (
				roomId: string,
				publicSharingToken: string | null,
			) => {
				// First check if we already have a token
				const existingToken = get().tokens[roomId]
				if (existingToken) {
					return existingToken
				}

				// Otherwise, try to refresh/fetch a new token
				return get().refreshJWT(roomId, publicSharingToken)
			},

			refreshJWT: async (
				roomId: string,
				publicSharingToken: string | null,
			) => {
				try {
					// Use the correct URL pattern
					const baseUrl = generateUrl(
						`apps/whiteboard/${roomId}/token`,
					)
					const url = publicSharingToken
						? `${baseUrl}?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
						: baseUrl

					const response = await axios.get(url, {
						withCredentials: true,
					})

					if (response.data && response.data.token) {
						set((state) => ({
							tokens: {
								...state.tokens,
								[roomId]: response.data.token,
							},
						}))

						return response.data.token
					}

					throw new Error('No token received')
				} catch (error) {
					console.error('Error refreshing JWT:', error)

					if (error instanceof Error) {
						alert(error.message)
					} else {
						alert('Failed to refresh authentication token')
					}

					return null
				}
			},

			clearJWT: (roomId: string) => {
				set((state) => {
					const newTokens = { ...state.tokens }
					delete newTokens[roomId]
					return { tokens: newTokens }
				})
			},

			clearAllJWT: () => {
				set({ tokens: {} })
			},
		}),
		{
			name: 'jwt-storage',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ tokens: state.tokens }),
		},
	),
)
