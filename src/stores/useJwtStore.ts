/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { useWhiteboardStore } from './useWhiteboardStore'

// Refresh token 90 seconds before expiration
const TOKEN_REFRESH_BUFFER = 90

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
	autoRefreshTimers: Record<string, number>

	getJWT: () => Promise<string | null>
	refreshJWT: () => Promise<string | null>
	executeWithJWT: <T>(apiCall: (token: string) => Promise<T>) => Promise<T>
	isTokenExpired: (roomId: string) => boolean
	parseJwt: (token: string) => JwtPayload | null
	setupAutoRefresh: (roomId: string) => void
	clearAutoRefresh: (roomId: string) => void
	clearTokens: () => void
}

export const useJWTStore = create<JWTStore>()(
	persist(
		(set, get) => ({
			tokens: {},
			tokenExpiries: {},
			autoRefreshTimers: {},

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

				const { tokens, isTokenExpired, setupAutoRefresh } = get()
				const token = tokens[fileId]

				if (token && !isTokenExpired(String(fileId))) {
					// Setup auto-refresh for this token if not already set up
					setupAutoRefresh(String(fileId))
					return token
				}

				const newToken = await get().refreshJWT()
				if (newToken) {
					// Setup auto-refresh for the new token
					setupAutoRefresh(String(fileId))
				}
				return newToken
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

					// Update read-only state based on the new JWT
					if (payload.isFileReadOnly !== undefined) {
						console.log(`[JWTStore] JWT indicates ${payload.isFileReadOnly ? 'read-only' : 'write'} access`)
						useWhiteboardStore.getState().setReadOnly(payload.isFileReadOnly)
					}

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
						&& (error.response as any).status !== undefined
						&& ((error.response as any).status === 401
							|| (error.response as any).status === 403)
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

			setupAutoRefresh: (roomId) => {
				const { autoRefreshTimers, tokenExpiries, refreshJWT } = get()

				// Clear any existing timer for this room
				if (autoRefreshTimers[roomId]) {
					clearTimeout(autoRefreshTimers[roomId])
				}

				// Get expiry time for this token
				const expiry = tokenExpiries[roomId]
				if (!expiry) {
					console.log(`[JWTStore] No expiry found for room ${roomId}, skipping auto-refresh setup`)
					return
				}

				// Calculate time until refresh (expiry - buffer)
				const now = Math.floor(Date.now() / 1000)
				const timeUntilRefresh = Math.max(0, (expiry - TOKEN_REFRESH_BUFFER - now) * 1000)

				console.log(`[JWTStore] Setting up auto-refresh for room ${roomId} in ${Math.round(timeUntilRefresh / 1000)} seconds (at ${new Date(Date.now() + timeUntilRefresh).toISOString()})`)

				// Set up the timer
				const timerId = window.setTimeout(async () => {
					console.log(`[JWTStore] Auto-refresh timer triggered for room ${roomId}`)
					await refreshJWT()

					// After refresh, set up the next auto-refresh
					get().setupAutoRefresh(roomId)
				}, timeUntilRefresh)

				// Store the timer ID
				set((state) => ({
					autoRefreshTimers: {
						...state.autoRefreshTimers,
						[roomId]: timerId,
					},
				}))
			},

			clearAutoRefresh: (roomId) => {
				const { autoRefreshTimers } = get()

				// Clear the timer if it exists
				if (autoRefreshTimers[roomId]) {
					clearTimeout(autoRefreshTimers[roomId])

					// Remove the timer from state
					set((state) => {
						const newTimers = { ...state.autoRefreshTimers }
						delete newTimers[roomId]
						return { autoRefreshTimers: newTimers }
					})

					console.log(`[JWTStore] Cleared auto-refresh timer for room ${roomId}`)
				}
			},

			clearTokens: () => {
				const { autoRefreshTimers } = get()

				// Clear all auto-refresh timers
				Object.values(autoRefreshTimers).forEach(timerId => {
					clearTimeout(timerId)
				})

				// Reset the store state
				set({
					tokens: {},
					tokenExpiries: {},
					autoRefreshTimers: {},
				})

				console.log('[JWTStore] All tokens and timers cleared')
			},
		}),
		{
			name: 'jwt-storage',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({
				tokens: state.tokens,
				tokenExpiries: state.tokenExpiries,
				// Don't persist timer IDs as they're not valid across sessions
				autoRefreshTimers: {},
			}),
		},
	),
)
