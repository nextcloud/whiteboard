<!--
 - SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<NcDialog :name="t('whiteboard', 'Start new voting')" @close="$emit('close')">
		<NcTextField v-model="question" :label="t('whiteboard', 'Question')" />
		<div class="voting-type">
			<label>{{ t('whiteboard', 'Voting type') }}</label>
			<NcSelect v-model="selectedType" :options="votingTypes" label="label" />
		</div>
		<div v-for="(option, index) in options" :key="index" class="option">
			<NcTextField v-model="options[index]" :label="t('whiteboard', 'Option') + ' ' + (index + 1)" />
			<NcButton type="tertiary" :aria-label="t('whiteboard', 'Remove option')" @click="removeOption(index)">
				<template #icon>
					<NcIconSvgWrapper :path="mdiDelete" />
				</template>
			</NcButton>
		</div>
		<div class="option-add">
			<NcButton @click="addOption">
				<template #icon>
					<NcIconSvgWrapper :path="mdiPlus" />
				</template>
				{{ t('whiteboard', 'Add option') }}
			</NcButton>
		</div>

		<template #actions>
			<NcButton @click="startVoting">
				<template #icon>
					<NcIconSvgWrapper :path="mdiCheck" />
				</template>
				{{ t('whiteboard', 'Start voting') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcIconSvgWrapper from '@nextcloud/vue/components/NcIconSvgWrapper'
import { NcDialog, NcTextField, NcButton, NcSelect } from '@nextcloud/vue'
import { translate as t } from '@nextcloud/l10n'
import { showError } from '@nextcloud/dialogs'
import { mdiPlus, mdiDelete, mdiCheck } from '@mdi/js'

export default {
	name: 'VotingModal',
	components: {
		NcDialog,
		NcTextField,
		NcButton,
		NcSelect,
		NcIconSvgWrapper,
	},
	props: {
		onStartVoting: {
			type: Function,
			required: true,
		},
	},
	data() {
		return {
			mdiPlus,
			mdiDelete,
			mdiCheck,
			question: '',
			options: ['', ''],
			votingTypes: [
				{ id: 'single-choice', label: t('whiteboard', 'Single choice') },
				{ id: 'multiple-choice', label: t('whiteboard', 'Multiple choice') },
			],
			selectedType: { id: 'single-choice', label: t('whiteboard', 'Single choice') },
		}
	},
	methods: {
		addOption() {
			this.options.push('')
		},
		removeOption(index) {
			// Prevent removing if only 2 options left
			if (this.options.length <= 2) {
				return
			}
			this.options.splice(index, 1)
		},
		startVoting() {
			const question = this.question.trim()
			if (!question) {
				showError(t('whiteboard', 'Please enter a question'))
				return
			}
			const validOptions = this.options.filter(opt => opt?.trim()).map(opt => opt.trim())
			if (validOptions.length < 2) {
				showError(t('whiteboard', 'Please enter at least 2 options'))
				return
			}
			this.onStartVoting(question, this.selectedType.id, validOptions)
			this.$emit('close')
		},
		t,
	},
}
</script>

<style scoped>
.voting-type {
	margin-bottom: 12px;
}
.voting-type label {
	display: block;
	margin-bottom: 4px;
	font-weight: bold;
}
.option {
	display: flex;
	align-items: center;
	margin-top: 4px;
}
.option-add {
	margin-top: 4px;
}
</style>
