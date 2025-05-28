/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from '@nextcloud/axios'
// @ts-expect-error - Type definitions issue with @nextcloud/router
import { generateUrl } from '@nextcloud/router'
import { useWhiteboardConfigStore } from './useWhiteboardConfigStore'

const TOKEN_REFRESH_BUFFER = 90

function isTokenFormatValid(token: string): boolean {
	const parts = token.split('.')
	return parts.length === 3 && !!parts[0] && !!parts[1] && !!parts[2]
}

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
	refreshPromise: Promise<string | null> | null

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
			refreshPromise: null,
			parseJwt: (token) => {
				try {
					if (!isTokenFormatValid(token)) {
						console.error('[JWTStore] Invalid token format')
						return null
					}

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

					const payload = JSON.parse(jsonPayload)

					if (!payload || typeof payload !== 'object') {
						console.error('[JWTStore] Invalid token payload structure')
						return null
					}

					if (!payload.exp || !payload.iat || !payload.userid || payload.fileId === undefined) {
						console.error('[JWTStore] Token missing required fields', payload)
						return null
					}

					const now = Math.floor(Date.now() / 1000)

					if (payload.exp < now) {
						console.error('[JWTStore] Token has expired')
					}

					return payload
				} catch (e) {
					console.error('[JWTStore] Error parsing JWT:', e)
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
				const { fileId } = useWhiteboardConfigStore.getState()

				const { tokens, isTokenExpired, setupAutoRefresh, parseJwt } = get()
				const token = tokens[fileId]
				const fileIdStr = String(fileId)

				if (token) {
					const payload = parseJwt(token)

					if (!payload) {
						console.error('[JWTStore] Stored token is invalid')
						console.log('[JWTStore] Will attempt to refresh invalid token')

						console.warn('[JWTStore] Invalid token, enforcing read-only mode until refresh completes')
						useWhiteboardConfigStore.getState().setReadOnly(true)
					} else if (!isTokenExpired(fileIdStr)) {

						if (payload.fileId === fileId) {

							setupAutoRefresh(fileIdStr)

							if (payload.isFileReadOnly !== undefined) {
								console.log(`[JWTStore] Setting permissions from valid token: ${payload.isFileReadOnly ? 'read-only' : 'write'} access`)
								useWhiteboardConfigStore.getState().setReadOnly(payload.isFileReadOnly)
							}

							return token
						} else {
							console.error(`[JWTStore] Stored token is for fileId ${payload.fileId}, but requested fileId is ${fileId}`)

							useWhiteboardConfigStore.getState().setReadOnly(true)
						}
					} else {
						console.log('[JWTStore] Token is expired, will attempt to refresh')

						console.warn('[JWTStore] Using expired token, enforcing read-only mode until refresh completes')
						useWhiteboardConfigStore.getState().setReadOnly(true)
					}
				}

				if (get().refreshPromise) {
					console.log('[JWTStore] Token refresh already in progress, waiting for it to complete')
					return get().refreshPromise
				}

				const refreshPromise = get().refreshJWT()
				set({ refreshPromise })

				try {
					const newToken = await refreshPromise
					if (newToken) {

						setupAutoRefresh(fileIdStr)
					}
					return newToken
				} finally {

					set({ refreshPromise: null })
				}
			},

			refreshJWT: async () => {
				const { fileId, publicSharingToken }
					= useWhiteboardConfigStore.getState()

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

					// Validate the token
					const payload = get().parseJwt(token)
					if (!payload || !payload.exp) {
						console.error(
							'[JWTStore] Invalid token payload:',
							payload,
						)
						return null
					}

					// Validate that the token is for the correct file
					if (payload.fileId !== fileId) {
						console.error(
							`[JWTStore] Token fileId (${payload.fileId}) doesn't match requested fileId (${fileId})`,
						)
						return null
					}

					// Store the token and its expiry
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
						useWhiteboardConfigStore.getState().setReadOnly(payload.isFileReadOnly)
					}

					return token
				} catch (error) {
					console.error('[JWTStore] Error refreshing JWT:', error)

					// Log network errors but continue with the same error handling
					if (error instanceof Error
						&& (error.message.includes('Network Error')
						 || error.message.includes('Failed to fetch')
						 || error.message.includes('timeout'))) {
						console.log('[JWTStore] Network error detected during token refresh')
					}

					// Return existing token if available, with proper validation
					const existingToken = get().tokens[fileId]
					if (existingToken) {
						// Always validate the token before using it after a refresh failure
						const payload = get().parseJwt(existingToken)
						if (!payload) {
							console.warn('[JWTStore] Invalid token after refresh failure, enforcing read-only mode')
							useWhiteboardConfigStore.getState().setReadOnly(true)
						} else {
							// Token is structurally valid, apply its permissions
							if (payload.isFileReadOnly !== undefined) {
								console.log(`[JWTStore] Setting permissions from fallback token: ${payload.isFileReadOnly ? 'read-only' : 'write'} access`)
								useWhiteboardConfigStore.getState().setReadOnly(payload.isFileReadOnly)
							}
						}
						console.log('[JWTStore] Using existing token after refresh failure')
						return existingToken
					}

					// No token available, default to read-only mode
					console.warn('[JWTStore] No token available after refresh failure, enforcing read-only mode')
					useWhiteboardConfigStore.getState().setReadOnly(true)
					return null
				}
			},

			executeWithJWT: async (apiCall) => {
				try {
					const token = await get().getJWT()

					if (!token) {
						// Default to read-only mode if no token is available
						console.warn('[JWTStore] No token available for API call, enforcing read-only mode')
						useWhiteboardConfigStore.getState().setReadOnly(true)
						throw new Error('Failed to obtain JWT token')
					}

					return await apiCall(token)
				} catch (error) {
					// Handle authentication errors (401/403)
					if (
						error instanceof Error
						&& 'response' in error
						&& error.response
						&& (error.response as any).status !== undefined
						&& ((error.response as any).status === 401
							|| (error.response as any).status === 403)
					) {
						// Authentication error indicates the token is invalid
						// Set read-only mode as a security precaution
						console.warn('[JWTStore] Authentication error, enforcing read-only mode')
						useWhiteboardConfigStore.getState().setReadOnly(true)

						// Always attempt to refresh the token regardless of connection state

						console.log(
							'[JWTStore] Token expired or invalid, refreshing and retrying...',
						)

						// If a refresh is already in progress, wait for it to complete
						if (get().refreshPromise) {
							console.log('[JWTStore] Token refresh already in progress, waiting for it to complete')
							const newToken = await get().refreshPromise
							if (!newToken) {
								throw new Error('Failed to refresh JWT token')
							}
							return await apiCall(newToken)
						}

						// Start a new refresh
						const refreshPromise = get().refreshJWT()
						set({ refreshPromise })

						try {
							const newToken = await refreshPromise
							if (!newToken) {
								throw new Error('Failed to refresh JWT token')
							}
							return await apiCall(newToken)
						} finally {
							// Clear the promise when done
							set({ refreshPromise: null })
						}
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
				// Don't persist timer IDs or refresh promises as they're not valid across sessions
				autoRefreshTimers: {},
				refreshPromise: null,
			}),
		},
	),
)
