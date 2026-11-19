<!--
 - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<NcDialog
		data-prevent-outside-click
		:name="t('whiteboard', 'Manage libraries')"
		size="normal"
		@keydown.esc.stop="onOpenUpdate(false)"
		@update:open="onOpenUpdate">
		<div class="libraries-dialog">
			<NcFormGroup>
				<template #label>
					<span class="libraries-dialog__heading">
						{{ t('whiteboard', 'Organization libraries') }}
					</span>
				</template>
				<NcFormBox>
					<NcFormBoxSwitch
						v-for="library in items"
						:key="library.name"
						:model-value="library.visible"
						:disabled="isSaving"
						:label="library.name"
						:description="n('whiteboard', '%n item', '%n items', library.itemCount)"
						@update:model-value="toggle(library, $event)" />
				</NcFormBox>
			</NcFormGroup>
			<NcFormGroup v-if="libraryUrl" :description="t('whiteboard', 'Discover libraries made by the Excalidraw community.')">
				<template #label>
					<span class="libraries-dialog__heading">
						{{ t('whiteboard', 'Community libraries') }}
					</span>
				</template>
				<NcFormBox>
					<NcFormBoxButton
						:label="t('whiteboard', 'Browse libraries')"
						description="libraries.excalidraw.com"
						:href="libraryUrl"
						target="_excalidraw_libraries" />
				</NcFormBox>
			</NcFormGroup>
		</div>
	</NcDialog>
</template>

<script>
import { translatePlural as n, translate as t } from '@nextcloud/l10n'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcFormBox from '@nextcloud/vue/components/NcFormBox'
import NcFormBoxButton from '@nextcloud/vue/components/NcFormBoxButton'
import NcFormBoxSwitch from '@nextcloud/vue/components/NcFormBoxSwitch'
import NcFormGroup from '@nextcloud/vue/components/NcFormGroup'

export default {
	name: 'LibrariesDialog',
	components: {
		NcDialog,
		NcFormBox,
		NcFormBoxButton,
		NcFormBoxSwitch,
		NcFormGroup,
	},

	props: {
		libraries: {
			type: Array,
			required: true,
		},

		libraryUrl: {
			type: String,
			default: null,
		},

		onToggle: {
			type: Function,
			required: true,
		},
	},

	emits: ['close'],
	data() {
		return {
			items: this.libraries.map((library) => ({ ...library })),
			isSaving: false,
		}
	},

	methods: {
		async toggle(library, visible) {
			this.isSaving = true
			library.visible = visible
			library.visible = await this.onToggle(library.name, visible) ? visible : !visible
			this.isSaving = false
		},

		onOpenUpdate(open) {
			if (!open) {
				this.$emit('close')
			}
		},

		n,
		t,
	},
}
</script>

<style scoped>
.libraries-dialog {
	display: flex;
	flex-direction: column;
	gap: calc(var(--default-grid-baseline) * 8);
	padding-bottom: calc(var(--default-grid-baseline) * 4);
}

.libraries-dialog__heading {
	font-size: 1.2em;
	font-weight: bold;
}
</style>
