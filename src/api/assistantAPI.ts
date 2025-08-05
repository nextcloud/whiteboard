/**
 * - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * - SPDX-License-Identifier: AGPL-3.0-or-later
 */
import axios, { type AxiosResponse } from '@nextcloud/axios'

async function getTaskResponse(taskId: number) {
	while (true) {
		const response = await axios.get(
			`/ocs/v2.php/taskprocessing/task/${taskId}`,
		)
		if (response.data.ocs.data.task.status === 'STATUS_SUCCESSFUL') {
			return response
		}
		if (response.data.ocs.data.task.status !== 'STATUS_RUNNING' && response.data.ocs.data.task.status !== 'STATUS_SCHEDULED') {
			throw new Error('Task failed')
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}

export async function ScheduleTask(prompt: string): Promise<AxiosResponse> {
	const wrappedPrompt = `You have to generate mermaid diagrams! Never generate anything else! Always use mermaid syntax! and do not include any other text or explanation. Also do not use the backticks to indicate you are generating mermaid. This is the user-prompt for the requested diagram: ${prompt}`
	return new Promise((resolve, reject) => {
		axios
			.post('/ocs/v2.php/taskprocessing/schedule', {
				input: { input: wrappedPrompt },
				type: 'core:text2text',
				appId: 'whiteboard',
			})
			.then((response) => {
				resolve(getTaskResponse(response.data.ocs.data.task.id))
			})
			.catch((error) => {
				reject(error)
			})
	})
}
