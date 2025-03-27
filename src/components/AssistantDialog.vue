<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script>
import { NcTextArea, NcTextField, NcButton, NcModal } from '@nextcloud/vue'
import { ScheduleTask } from '../api/assistantAPI'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { convertToExcalidrawElements, exportToCanvas } from '@excalidraw/excalidraw'
import { defineComponent } from 'vue'

export default defineComponent({
	name: 'AssistantDialog',
	components: {
		NcTextField,
		NcButton,
		NcModal,
		NcTextArea,
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
			taskResponse: '',
			generatedElements: {},
			mermaidError: false,
		}
	},
	watch: {
		taskResponse() {
			if (!this.waitingForTask) {
				this.loadPreviewMermaid()
			}
		},
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
		onSubmit() {
			this.$emit('submit', this.generatedElements)
		},
		async loadPreviewMermaid() {
			this.mermaidError = false
			parseMermaidToExcalidraw(this.taskResponse).then(async (res) => {
				const { elements, files } = res
				const data = {
					elements: convertToExcalidrawElements(elements, { regenerateIds: true }),
					files,
				}
				const canvas = await exportToCanvas({ ...data, exportPadding: 10 })
				this.$refs.canvasRef.innerHTML = ''
				this.$refs.canvasRef.appendChild(canvas)
				this.generatedElements = data
			}).catch((error) => {
				this.mermaidError = error
			})
			this.waitingForTask = false
		},
		onGetTask() {
			this.waitingForTask = true
			ScheduleTask(this.assistantQuery).then(response => {
				this.waitingForTask = false
				this.taskResponse = response.data.ocs.data.task.output.output
			}).catch(() => {
				this.waitingForTask = false
			})
		},
	},
})

</script>

<template>
	<NcModal v-if="show"
		:can-close="true"
		size="large"
		@close="onCancel">
		<div class="assistant-dialog">
			<div v-if="!waitingForTask && !taskResponse">
				<NcTextField ref="assistantDialog"
					v-model="assistantQuery"
					label="Assistant"
					type="text" />
				<div class="dialog-buttons">
					<NcButton type="submit"
						@click="onCancel">
						Close
					</NcButton>
					<NcButton type="submit" @click="onGetTask">
						Generate
					</NcButton>
				</div>
			</div>
			<div v-else-if="!waitingForTask && taskResponse" class="preview-wrapper">
				<div class="preview">
					<NcTextArea v-model="taskResponse"
						class="generated"
						input-class="generated-input"
						label="Generated mermaid"
						resize="none"
						type="text"
						@change="loadPreviewMermaid" />
					<div class="preview-canvas-wrapper">
						<div ref="canvasRef" class="assistant-mermaid-preview" />
					</div>
					<div v-if="mermaidError" class="mermaid-error">
						{{ mermaidError }}
					</div>
				</div>
				<div class="dialog-buttons">
					<NcButton type="submit"
						@click="() => taskResponse = ''">
						back
					</NcButton>
					<NcButton type="submit" @click="onSubmit">
						submit
					</NcButton>
				</div>
			</div>
			<div v-else>
				Task is loading this may take a while
			</div>
		</div>
	</NcModal>
</template>
<style>
.assistant-mermaid-preview{
	height: 100%;
	canvas{
		height: 100%;
		width: 100%;
	}
}
.generated{
	.textarea__main-wrapper{
		height: 100%;
	}
	.textarea__input{
		height: 100%;
	}
}
</style>
<style scoped lang="scss">
.preview-button{
	height: 1rem;
}
.assistant-dialog{
	height: 100%;
	display: flex;
	flex-direction: column;
	justify-content: space-evenly;
}
.preview-wrapper{
	height: 100%;
	display: flex;
	flex-direction: column;
	justify-content: space-between;
	padding: 15px;
	padding-top: 30px;
}

.preview{
	height: 90%;
	display: flex;
	flex-direction: row;
	align-items: flex-start;
}

.generated{
	width: 50%;
	height: 100%;
}

.preview-canvas-wrapper{
	height: 100%;
	width: 50%;
	flex-grow: 1;
	display: flex;
	justify-content: center;
}

.dialog-buttons{
	display: flex;
	justify-content: space-between;
	align-items: center;
	width: 100%;
}

.mermaid-error {
	position: absolute;
	left: 50%;
	text-align: center;
	color: red;
	font-size: 1.2rem;
	font-weight: bold;
}

</style>
