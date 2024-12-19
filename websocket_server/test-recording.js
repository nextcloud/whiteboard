/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import { RecordingService } from './RecordingService.js'

async function test() {
	const recorder = new RecordingService()

	// Add event listeners
	recorder.on('initialized', ({ boardUrl }) => console.log('Recorder initialized:', boardUrl))
	recorder.on('error', (error) => console.error('Recorder error:', error))
	recorder.on('cleanup', () => console.log('Recorder cleaned up'))

	try {
		const initialized = await recorder.init(
			'https://nextcloud.local/index.php/s/tWNNgy2KEGaFxkk?dir=/&openfile=true',
		)

		if (!initialized) {
			console.error('Failed to initialize recorder')
			return
		}

		// Follow a user
		await recorder.followUser('admin')

		// Start recording
		await recorder.startRecording('test-session-1')

		// Record for 30 seconds
		await new Promise((resolve) => setTimeout(resolve, 30000))

		// Stop recording
		await recorder.stopRecording()
	} catch (error) {
		console.error('Test failed:', error)
	} finally {
		await recorder.cleanup()
		console.log('Final recorder status:', recorder.getStatus())
	}
}

test()
