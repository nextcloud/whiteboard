<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script>
import { NcTextField, NcButton, NcModal, NcLoadingIcon } from '@nextcloud/vue'
import { ScheduleTask } from '../api/assistantAPI'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { defineComponent } from 'vue'

export default defineComponent({
	name: 'AssistantDialog',
	components: {
		NcTextField,
		NcButton,
		NcModal,
		NcLoadingIcon,
	},
	props: {
		excalidrawAPI: {
			type: Object,
			required: true,
		},
	},
	emits: ['cancel', 'submit'],
	data() {
		return {
			assistantQuery: '',
			show: true,
			waitingForTask: false,
			generatedElements: {},
			mermaidError: false,
		}
	},
	mounted() {
		this.$nextTick(() => {
			this.$refs.assistantDialog.focus()
		})
	},
	methods: {
		onCancel() {
			this.show = false
			this.$emit('cancel')
		},
		async getExcalidrawElements(taskResponse) {
			this.mermaidError = false

			const { elements, files } = await parseMermaidToExcalidraw(taskResponse)
			const data = {
				elements: convertToExcalidrawElements(elements, { regenerateIds: true }),
				files,
			}
			return data
		},
		async onGetTask() {
			this.waitingForTask = true
			this.mermaidError = false

			try {
				const response = await ScheduleTask(this.assistantQuery)
				const taskResponse = response.data.ocs.data.task.output.output

				const res = await this.getExcalidrawElements(taskResponse)
				this.$emit('submit', res)
			} catch (error) {
				this.mermaidError = error || 'An error occurred while creating the diagram'
				console.error('Error generating diagram:', this.mermaidError)
			} finally {
				this.waitingForTask = false
			}
		},
	},
})

</script>

<template>
	<NcModal v-if="show"
		:can-close="true"
		size="normal"
		@close="onCancel">
		<div class="assistant-dialog">
			<div v-if="!waitingForTask">
				<h2>
					Generate diagram
				</h2>
				<div v-if="mermaidError" class="mermaid-error">
					Something went wrong, please try again
				</div>
				<form @submit.prevent="onGetTask">
					<NcTextField ref="assistantDialog"
						v-model="assistantQuery"
						label="Query"
						aria-placeholder="Flowchart, sequence diagram..."
						type="text" />
					<div class="dialog-buttons">
						<NcButton @click="onCancel">
							Close
						</NcButton>
						<NcButton type="submit">
							Generate
						</NcButton>
					</div>
				</form>
			</div>
			<NcLoadingIcon v-else />
		</div>
	</NcModal>
</template>
<style scoped lang="scss">
h2 {
    text-align: center;
}
.assistant-dialog {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
    overflow: hidden;
}
.dialog-buttons {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
}
.mermaid-error {
	text-align: center;
    font-weight: bold;
}
</style>
