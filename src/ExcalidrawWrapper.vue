<template>
	<div id='whiteboard' ref='whiteboard'></div>
</template>

<script lang='tsx'>
import { defineComponent } from 'vue'
import { createRoot } from 'react-dom'
import { StrictMode } from 'react'
import App from './App'

export default defineComponent({
	name: 'ExcalidrawWrapper',

	props: {
		initialData: Object,
	},

	mounted() {
		const rootElement = this.$refs.whiteboard;
		const root = createRoot(rootElement);

		root.render(
			<StrictMode>
				<App initialData={
					{
						...this.initialData,
						scrollToContent: true,
					}
				} />
			</StrictMode>
		);
	}
})
</script>
