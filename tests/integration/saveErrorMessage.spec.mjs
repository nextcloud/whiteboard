/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@nextcloud/l10n', () => ({ translate: (app, text) => text }))

const { saveErrorMessage } = await import('../../src/utils/saveErrorMessage.ts')

const failed = (status) => Object.assign(new Error('Failed'), { status })

describe('save error message', () => {
	it('tells the user how to create a Templates folder when theirs cannot be found or created', () => {
		expect(saveErrorMessage(failed(424), 'Name taken', 'Could not save library.'))
			.toBe('Your Templates folder could not be found or created. In Files, open the "New" menu, choose "Create templates folder" and try again. If that is not possible, ask your administrator.')
	})

	it('keeps the generic message when a file is not found', () => {
		expect(saveErrorMessage(failed(404), 'Name taken', 'Could not save library.')).toBe('Could not save library.')
	})

	it('reports a name conflict', () => {
		expect(saveErrorMessage(failed(409), 'Name taken', 'Could not save library.')).toBe('Name taken')
	})

	it('keeps the generic message for other failures', () => {
		expect(saveErrorMessage(failed(500), 'Name taken', 'Could not save library.')).toBe('Could not save library.')
		expect(saveErrorMessage(new Error('No JWT'), 'Name taken', 'Could not save library.')).toBe('Could not save library.')
	})
})
