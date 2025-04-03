import axios, { type AxiosResponse } from '@nextcloud/axios'

async function getTaskResponse(taskId: number) {
	while (true) {
		const response = await axios.get(
			`/ocs/v2.php/taskprocessing/task/${taskId}`,
		)
		if (response.data.ocs.data.task.status === 'STATUS_SUCCESSFUL') {
			return response
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}

export async function ScheduleTask(prompt: string):Promise<AxiosResponse> {
	return new Promise((resolve, reject) => {
		axios
			.post('/ocs/v2.php/taskprocessing/schedule', {
				input: { input: prompt },
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
