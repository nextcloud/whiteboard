/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

interface JWTStore {
	tokens: Record<string, string>

	getJWT: (
		roomId: string,
		publicSharingToken: string | null,
	) => Promise<string | null>
	refreshJWT: (
		roomId: string,
		publicSharingToken: string | null,
	) => Promise<string | null>
	executeWithJWT: <T>(
		roomId: string,
		publicSharingToken: string | null,
		apiCall: (token: string) => Promise<T>,
	) => Promise<T>
}

export const useJWTStore = create<JWTStore>()(
	persist(
		(set, get) => ({
			tokens: {},

			getJWT: async (
				roomId: string,
				publicSharingToken: string | null,
			) => {
				const existingToken = get().tokens[roomId]
				if (existingToken) {
					return existingToken
				}

				return get().refreshJWT(roomId, publicSharingToken)
			},

			refreshJWT: async (
				roomId: string,
				publicSharingToken: string | null,
			) => {
				try {
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

			executeWithJWT: async <T>(
				roomId: string,
				publicSharingToken: string | null,
				apiCall: (token: string) => Promise<T>,
			): Promise<T> => {
				// Get a valid token
				const token = await get().getJWT(roomId, publicSharingToken)
				if (!token) {
					throw new Error('Could not get authentication token')
				}

				try {
					// Execute the API call with the token
					return await apiCall(token)
				} catch (error) {
					// If it's an auth error, refresh token and retry once
					if (
						error.response
						&& (error.response.status === 401
							|| error.response.status === 403)
					) {
						console.log(
							'Auth error, refreshing token and retrying...',
						)

						// Force token refresh by clearing it first
						set((state) => {
							const newTokens = { ...state.tokens }
							delete newTokens[roomId]
							return {
								tokens: newTokens,
							}
						})

						// Get a fresh token
						const newToken = await get().refreshJWT(
							roomId,
							publicSharingToken,
						)
						if (!newToken) {
							throw new Error(
								'Could not refresh authentication token',
							)
						}

						// Retry the API call with the new token
						return await apiCall(newToken)
					}

					// If it's not an auth error or the retry failed, rethrow
					throw error
				}
			},
		}),
		{
			name: 'jwt-storage',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ tokens: state.tokens }),
		},
	),
)
