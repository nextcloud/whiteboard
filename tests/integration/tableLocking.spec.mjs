/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isLockExpired, setLockOnElement, tryAcquireLock, releaseLock } from '../../src/utils/tableLocking.ts'
import * as auth from '@nextcloud/auth'
import * as dialogs from '@nextcloud/dialogs'

// Mock the Nextcloud modules
vi.mock('@nextcloud/auth', () => ({
	getCurrentUser: vi.fn(() => ({
		uid: 'test-user',
		displayName: 'Test User',
	})),
}))

vi.mock('@nextcloud/dialogs', () => ({
	showError: vi.fn(),
}))

describe('tableLocking utilities', () => {
	describe('isLockExpired', () => {
		it('should return true for undefined lock', () => {
			expect(isLockExpired(undefined)).toBe(true)
		})

		it('should return true for lock without lockedAt', () => {
			expect(isLockExpired({})).toBe(true)
		})

		it('should return false for fresh lock', () => {
			const lock = { lockedAt: Date.now() }
			expect(isLockExpired(lock)).toBe(false)
		})

		it('should return true for expired lock (older than 5 minutes)', () => {
			const sixMinutesAgo = Date.now() - (6 * 60 * 1000)
			const lock = { lockedAt: sixMinutesAgo }
			expect(isLockExpired(lock)).toBe(true)
		})

		it('should return false for lock just under 5 minutes old', () => {
			const fourMinutesAgo = Date.now() - (4 * 60 * 1000)
			const lock = { lockedAt: fourMinutesAgo }
			expect(isLockExpired(lock)).toBe(false)
		})
	})

	describe('setLockOnElement', () => {
		let mockAPI
		let mockElements

		beforeEach(() => {
			mockElements = [
				{
					id: 'element-1',
					type: 'image',
					customData: { isTable: true },
				},
				{
					id: 'element-2',
					type: 'image',
					customData: { isTable: true },
				},
			]

			mockAPI = {
				getSceneElementsIncludingDeleted: vi.fn(() => mockElements),
				updateScene: vi.fn(),
			}
		})

		it('should set lock on element', () => {
			const lock = {
				uid: 'user-1',
				displayName: 'User One',
				lockedAt: Date.now(),
			}

			setLockOnElement(mockAPI, 'element-1', lock)

			expect(mockAPI.updateScene).toHaveBeenCalledTimes(1)
			const updateCall = mockAPI.updateScene.mock.calls[0][0]
			expect(updateCall.elements[0].customData.tableLock).toEqual(lock)
		})

		it('should clear lock on element when lock is undefined', () => {
			mockElements[0].customData.tableLock = {
				uid: 'user-1',
				displayName: 'User One',
				lockedAt: Date.now(),
			}

			setLockOnElement(mockAPI, 'element-1', undefined)

			expect(mockAPI.updateScene).toHaveBeenCalledTimes(1)
			const updateCall = mockAPI.updateScene.mock.calls[0][0]
			expect(updateCall.elements[0].customData.tableLock).toBeUndefined()
		})

		it('should do nothing if element not found', () => {
			setLockOnElement(mockAPI, 'non-existent-id', undefined)

			expect(mockAPI.updateScene).not.toHaveBeenCalled()
		})

		it('should preserve other customData properties', () => {
			mockElements[1].customData = {
				isTable: true,
				tableHtml: '<table><tr><td>test</td></tr></table>',
			}

			const lock = {
				uid: 'user-1',
				displayName: 'User One',
				lockedAt: Date.now(),
			}

			setLockOnElement(mockAPI, 'element-2', lock)

			const updateCall = mockAPI.updateScene.mock.calls[0][0]
			expect(updateCall.elements[1].customData.isTable).toBe(true)
			expect(updateCall.elements[1].customData.tableHtml).toBe('<table><tr><td>test</td></tr></table>')
			expect(updateCall.elements[1].customData.tableLock).toEqual(lock)
		})
	})

	describe('tryAcquireLock', () => {
		let mockAPI
		let mockElement

		beforeEach(() => {
			mockElement = {
				id: 'table-1',
				type: 'image',
				customData: { isTable: true },
			}

			mockAPI = {
				getSceneElementsIncludingDeleted: vi.fn(() => [mockElement]),
				updateScene: vi.fn(),
			}

			vi.clearAllMocks()
		})

		it('should acquire lock when no lock exists', async () => {
			const result = await tryAcquireLock(mockAPI, mockElement)

			expect(result).toBe(true)
			expect(mockAPI.updateScene).toHaveBeenCalled()
			const updateCall = mockAPI.updateScene.mock.calls[0][0]
			expect(updateCall.elements[0].customData.tableLock).toHaveProperty('uid', 'test-user')
			expect(updateCall.elements[0].customData.tableLock).toHaveProperty('displayName', 'Test User')
			expect(updateCall.elements[0].customData.tableLock).toHaveProperty('lockedAt')
		})

		it('should acquire lock when existing lock is expired', async () => {
			const sixMinutesAgo = Date.now() - (6 * 60 * 1000)
			mockElement.customData.tableLock = {
				uid: 'other-user',
				displayName: 'Other User',
				lockedAt: sixMinutesAgo,
			}

			const result = await tryAcquireLock(mockAPI, mockElement)

			expect(result).toBe(true)
			expect(mockAPI.updateScene).toHaveBeenCalled()
		})

		it('should reacquire lock when same user already has it', async () => {
			mockElement.customData.tableLock = {
				uid: 'test-user',
				displayName: 'Test User',
				lockedAt: Date.now(),
			}

			const result = await tryAcquireLock(mockAPI, mockElement)

			expect(result).toBe(true)
			expect(mockAPI.updateScene).toHaveBeenCalled()
		})

		it('should fail to acquire lock when another user has valid lock', async () => {
			mockElement.customData.tableLock = {
				uid: 'other-user',
				displayName: 'Other User',
				lockedAt: Date.now(),
			}

			const result = await tryAcquireLock(mockAPI, mockElement)

			expect(result).toBe(false)
			expect(dialogs.showError).toHaveBeenCalledWith('This table is currently being edited by Other User')
			expect(mockAPI.updateScene).not.toHaveBeenCalled()
		})

		it('should return false when user is not available', async () => {
			vi.mocked(auth.getCurrentUser).mockReturnValueOnce(null)

			const result = await tryAcquireLock(mockAPI, mockElement)

			expect(result).toBe(false)
			expect(mockAPI.updateScene).not.toHaveBeenCalled()
		})
	})

	describe('releaseLock', () => {
		let mockAPI
		let mockElement

		beforeEach(() => {
			mockElement = {
				id: 'table-1',
				type: 'image',
				customData: {
					isTable: true,
					tableLock: {
						uid: 'test-user',
						displayName: 'Test User',
						lockedAt: Date.now(),
					},
				},
			}

			mockAPI = {
				getSceneElementsIncludingDeleted: vi.fn(() => [mockElement]),
				updateScene: vi.fn(),
			}
		})

		it('should release lock on element', () => {
			releaseLock(mockAPI, 'table-1')

			expect(mockAPI.updateScene).toHaveBeenCalledTimes(1)
			const updateCall = mockAPI.updateScene.mock.calls[0][0]
			expect(updateCall.elements[0].customData.tableLock).toBeUndefined()
		})

		it('should handle errors gracefully', () => {
			mockAPI.getSceneElementsIncludingDeleted.mockImplementation(() => {
				throw new Error('Test error')
			})

			// Should not throw
			expect(() => releaseLock(mockAPI, 'table-1')).not.toThrow()
		})
	})
})
