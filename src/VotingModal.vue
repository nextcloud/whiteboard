<template>
	<NcDialog :name="t('whiteboard', 'Start new voting')" @close="$emit('close')">
		<NcTextField v-model="question" :label="t('whiteboard', 'Question')" />
		<div v-for="(option, index) in options" :key="index" class="option">
			<NcTextField v-model="options[index]" :label="t('whiteboard', 'Option') + ' ' + (index + 1)" />
			<NcButton type="tertiary" :aria-label="t('whiteboard', 'Remove option')" @click="removeOption(index)">
				<template #icon>
					<DeleteIcon />
				</template>
			</NcButton>
		</div>
		<div class="option-add">
			<NcButton @click="addOption">
				<template #icon>
					<AddIcon />
				</template>
				{{ t('whiteboard', 'Add option') }}
			</NcButton>
		</div>

		<template #actions>
			<NcButton @click="startVoting">
				<template #icon>
					<CheckIcon />
				</template>
				{{ t('whiteboard', 'Start voting') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import { NcDialog, NcTextField, NcButton } from '@nextcloud/vue'
import { translate as t } from '@nextcloud/l10n'
import AddIcon from 'vue-material-design-icons/Plus.vue'
import DeleteIcon from 'vue-material-design-icons/Delete.vue'
import CheckIcon from 'vue-material-design-icons/Check.vue'
import { SOCKET_MSG } from './shared/contants.js'

export default {
	name: 'VotingModal',
	components: {
		NcDialog,
		NcTextField,
		NcButton,
		AddIcon,
		DeleteIcon,
		CheckIcon,
	},
	props: {
		collab: {
			type: Object,
			required: true,
		},
	},
	data() {
		return {
			question: '',
			options: [''],
		}
	},
	methods: {
		addOption() {
			this.options.push('')
		},
		removeOption(index) {
			this.options.splice(index, 1)
		},
		startVoting() {
			const voting = {
				question: this.question,
				options: this.options,
			}
			this.collab.portal.socket.emit(SOCKET_MSG.VOTING_START, this.collab.portal.roomId, voting)
			this.$emit('close')
		},
		t,
	},
}
</script>

<style scoped>
.option {
	display: flex;
	align-items: center;
	margin-top: 4px;
}
.option-add {
	margin-top: 4px;
}
</style>
