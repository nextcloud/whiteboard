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
	<NcModal v-if="show" :can-close="true" @close="onCancel">
		<div class="assistant-dialog">
			<div v-if="!waitingForTask && !taskResponse">
				<NcTextField ref="assistantDialog"
					v-model="assistantQuery"
					label="Assistant"
					type="text" />
				<NcButton type="submit"
					@click="onCancel">
					Close
				</NcButton>
				<NcButton type="submit" @click="onSubmit">
					submit
				</NcButton>
			</div>
			<div v-else-if="!waitingForTask && taskResponse" class="preview-wrapper">
				<NcTextArea v-model="taskResponse"
					label="Generated mermaid"
					type="text" />
				<NcButton type="submit" @click="loadPreviewMermaid">
					preview
				</NcButton>
				<div ref="canvasRef" class="assistant-mermaid-preview" />
				<NcButton type="submit" @click="onLoadToEditor">
					submit
				</NcButton>
			</div>
		</div>
	</NcModal>
</template>

<style scoped>
.preview-wrapper {
	display: flex;
	flex-direction: column;
	align-items: center;
}

.assistant-mermaid-preview {
	margin-block: 20px;
	align-self: flex-end;
}

.assistant-dialog {
	padding-block: 25px;
}
</style>
