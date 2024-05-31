<template>
	<ExcalidrawWrapper v-if='contentLoaded' :initial-data="content" />
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import axios from '@nextcloud/axios'
import ExcalidrawWrapper from './ExcalidrawWrapper.vue'

export default defineComponent({
	name: 'Whiteboard',
	components: { ExcalidrawWrapper },

	props: {
		filename: {
			type: String,
			default: null,
		},
		fileid: {
			type: Number,
			default: null,
		},
	},
	data() {
		return {
			content: null,
			contentLoaded: false,
		}
	},
	mounted() {
		this.loadFileContent()
	},
	methods: {
		async loadFileContent() {
			const response = await axios.get(this.source)
			this.content = response.data
			this.contentLoaded = true
			this.$emit('update:loaded', true)
		},
	},
})
</script>
