<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script>
import { NcTextField, NcButton, NcModal } from '@nextcloud/vue'
import { t } from '@nextcloud/l10n'
import { ScheduleTask } from '../services/assistant/api'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { convertToExcalidrawElements } from '@nextcloud/excalidraw'
import { defineComponent } from 'vue'

export default defineComponent({
	name: 'AssistantDialog',
	components: {
		NcTextField,
		NcButton,
		NcModal,
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
		t,
		onCancel() {
			this.show = false
			this.$emit('cancel')
		},
		async getExcalidrawElements(taskResponse) {
			this.mermaidError = false

			const { elements, files } = await parseMermaidToExcalidraw(taskResponse)
			elements.forEach((element) => {
				// set font family (6 should always be Nunito)
				if (element.label) {
					element.label.fontFamily = 6
				}
				if (element.type === 'text') {
					element.fontFamily = 6
				}
				element.roughness = 0
			})
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
				this.mermaidError = error || t('whiteboard', 'An error occurred while creating the diagram')
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
			<div>
				<h2>
					{{ t('whiteboard', 'Generate diagram') }}
				</h2>
				<div v-if="mermaidError" class="mermaid-error">
					{{ t('whiteboard', 'Something went wrong, please try again') }}
				</div>
				<form @submit.prevent="onGetTask">
					<NcTextField ref="assistantDialog"
						v-model="assistantQuery"
						:label="t('whiteboard', 'Prompt to generate diagram')"
						:placeholder="t('whiteboard', 'Flowchart, sequence diagram…')"
						type="text"
						:disabled="waitingForTask" />
					<div class="dialog-buttons">
						<NcButton @click="onCancel">
							{{ t('whiteboard', 'Close') }}
						</NcButton>
						<NcButton :disabled="waitingForTask" type="submit">
							{{ waitingForTask ? t('whiteboard', 'Generating…') : t('whiteboard', 'Generate') }}
						</NcButton>
					</div>
				</form>
			</div>
		</div>
	</NcModal>
</template>
<style scoped lang="scss">
.loading-icon {
	padding: 30px;
}
h2 {
    text-align: center;
}
.assistant-dialog {
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
    overflow: hidden;
	form {
		padding-inline: 10px;
	}
}
.dialog-buttons {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
	padding-block: 10px;
}
.mermaid-error {
	text-align: center;
    font-weight: bold;
}
</style>
