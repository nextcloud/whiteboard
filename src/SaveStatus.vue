<template>
	<NcButton type="tertiary" v-on:click="onClick">
		<template #icon>
			<NcSavingIndicatorIcon :saving="saving" />
		</template>
	</NcButton>
</template>

<script>
import { NcButton, NcSavingIndicatorIcon } from '@nextcloud/vue'
export default {
	name: "SaveStatus",
	components: {
		NcButton,
		NcSavingIndicatorIcon,
	},
	props: {
		saving: {
			type: Boolean,
			default: false
		},
		onClick: {
			type: Function
		}
	},
}
</script>
