<script>
import { NcTextArea, NcTextField, NcButton, NcModal } from '@nextcloud/vue'
import { ScheduleTask } from './assistantApi'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { convertToExcalidrawElements, exportToCanvas, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import { getViewPortCenter, moveElementsAroundCoords } from '../utils'
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
		excalidrawApi: {
			type: Object,
			required: true,
		},
	},
	emits: ['cancel'],
	data() {
		return {
			assistantQuery: '',
			show: true,
			waitingForTask: false,
			taskResponse: '',
			generatedElements: {},
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
		onLoadToEditor() {
			const elements = this.excalidrawApi.getSceneElementsIncludingDeleted().slice()
			const movedElements = moveElementsAroundCoords(this.generatedElements.elements, viewportCoordsToSceneCoords(getViewPortCenter(), this.excalidrawApi.getAppState()))
			elements.push(...movedElements)
			this.excalidrawApi.updateScene({
				elements,
			})
			this.onCancel()
		},
		async loadPreviewMermaid() {
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
			})
			this.waitingForTask = false
		},
		onSubmit() {
			this.waitingForTask = true
			ScheduleTask(this.assistantQuery).then(response => {
				this.taskResponse = response.data.ocs.data.task.output.output
				this.loadPreviewMermaid()
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
					<NcButton type="submit" @click="onSubmit">
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
				</div>
				<div class="dialog-buttons">
					<NcButton type="submit"
						@click="() => taskResponse = ''">
						back
					</NcButton>
					<NcButton type="submit" @click="onLoadToEditor">
						submit
					</NcButton>
				</div>
			</div>
		</div>
	</NcModal>
</template>
<style>
.assistant-mermaid-preview{
	height: 100%;
	canvas{
		height: 100%;
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

</style>
