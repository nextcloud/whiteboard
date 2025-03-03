/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { useWhiteboardStore } from './useWhiteboardStore'

const TOKEN_REFRESH_BUFFER = 60

interface JwtPayload {
	userid: string
	fileId: number
	isFileReadOnly: boolean
	user: {
		id: string
		name: string
	}
	iat: number
	exp: number
}

interface JWTStore {
	tokens: Record<string, string>
	tokenExpiries: Record<string, number>

	getJWT: () => Promise<string | null>
	refreshJWT: () => Promise<string | null>
	executeWithJWT: <T>(apiCall: (token: string) => Promise<T>) => Promise<T>
	isTokenExpired: (roomId: string) => boolean
	parseJwt: (token: string) => JwtPayload | null
}

export const useJWTStore = create<JWTStore>()(
	persist(
		(set, get) => ({
			tokens: {},
			tokenExpiries: {},

			parseJwt: (token) => {
				try {
					const base64Url = token.split('.')[1]
					const base64 = base64Url
						.replace(/-/g, '+')
						.replace(/_/g, '/')
					const jsonPayload = decodeURIComponent(
						atob(base64)
							.split('')
							.map(
								(c) =>
									'%'
									+ ('00' + c.charCodeAt(0).toString(16)).slice(
										-2,
									),
							)
							.join(''),
					)
					return JSON.parse(jsonPayload)
				} catch (e) {
					console.error('Error parsing JWT:', e)
					return null
				}
			},

			isTokenExpired: (roomId) => {
				const { tokens, tokenExpiries } = get()
				const token = tokens[roomId]
				const expiry = tokenExpiries[roomId]

				if (!token || !expiry) {
					return true
				}

				const now = Math.floor(Date.now() / 1000)
				return now >= expiry - TOKEN_REFRESH_BUFFER
			},

			getJWT: async () => {
				const { fileId } = useWhiteboardStore.getState()

				const { tokens, isTokenExpired } = get()
				const token = tokens[fileId]

				if (token && !isTokenExpired(String(fileId))) {
					return token
				}

				return get().refreshJWT()
			},

			refreshJWT: async () => {
				const { fileId, publicSharingToken }
					= useWhiteboardStore.getState()

				try {
					console.log(`[JWTStore] Refreshing JWT for room ${fileId}`)

					const baseUrl = generateUrl(
						`apps/whiteboard/${fileId}/token`,
					)
					const url = publicSharingToken
						? `${baseUrl}?publicSharingToken=${encodeURIComponent(publicSharingToken)}`
						: baseUrl

					const response = await axios.get(url, {
						withCredentials: true,
					})
					const { token } = response.data

					if (!token) {
						console.error(
							'[JWTStore] No token received from server',
						)
						return null
					}

					const payload = get().parseJwt(token)
					if (!payload || !payload.exp) {
						console.error(
							'[JWTStore] Invalid token payload:',
							payload,
						)
						return null
					}

					set((state) => ({
						tokens: {
							...state.tokens,
							[fileId]: token,
						},
						tokenExpiries: {
							...state.tokenExpiries,
							[fileId]: payload.exp,
						},
					}))

					console.log(
						`[JWTStore] JWT refreshed for room ${fileId}, expires at ${new Date(payload.exp * 1000).toISOString()}`,
					)
					return token
				} catch (error) {
					console.error('[JWTStore] Error refreshing JWT:', error)
					return null
				}
			},

			executeWithJWT: async (apiCall) => {
				try {
					const token = await get().getJWT()

					if (!token) {
						throw new Error('Failed to obtain JWT token')
					}

					return await apiCall(token)
				} catch (error) {
					if (
						error instanceof Error
						&& 'response' in error
						&& error.response
						&& (error.response.status === 401
							|| error.response.status === 403)
					) {
						console.log(
							'[JWTStore] Token expired, refreshing and retrying...',
						)

						const newToken = await get().refreshJWT()

						if (!newToken) {
							throw new Error('Failed to refresh JWT token')
						}

						return await apiCall(newToken)
					}

					throw error
				}
			},
		}),
		{
			name: 'jwt-storage',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({
				tokens: state.tokens,
				tokenExpiries: state.tokenExpiries,
			}),
		},
	),
)
