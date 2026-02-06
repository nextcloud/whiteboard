<!--
  - SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div>
		<NcSettingsSection :name="t('whiteboard', 'Recording')">
			<p class="settings-help">
				{{ t('whiteboard', 'Choose what happens to your recording if you leave a board.') }}
			</p>
			<NcCheckboxRadioSwitch :checked="autoUploadOnDisconnect"
				:loading="saving"
				type="switch"
				@update:checked="onToggle">
				{{ t('whiteboard', 'Save recordings automatically when I leave a board') }}
				<template #description>
					{{ t('whiteboard', 'When enabled, the server will save your recording if you close the tab or lose connection.') }}
				</template>
			</NcCheckboxRadioSwitch>
			<NcNoteCard v-if="notice" :type="notice.type" class="settings-note">
				{{ notice.message }}
			</NcNoteCard>
		</NcSettingsSection>
	</div>
</template>

<script>
import axios from '@nextcloud/axios'
import { loadState } from '@nextcloud/initial-state'
import { generateUrl } from '@nextcloud/router'
import { t } from '@nextcloud/l10n'
import NcCheckboxRadioSwitch from '@nextcloud/vue/dist/Components/NcCheckboxRadioSwitch.js'
import NcNoteCard from '@nextcloud/vue/dist/Components/NcNoteCard.js'
import NcSettingsSection from '@nextcloud/vue/dist/Components/NcSettingsSection.js'
import { showError } from '@nextcloud/dialogs'

export default {
	name: 'PersonalSettings',
	components: {
		NcCheckboxRadioSwitch,
		NcNoteCard,
		NcSettingsSection,
	},
	data() {
		return {
			autoUploadOnDisconnect: loadState('whiteboard', 'autoUploadOnDisconnect', false),
			saving: false,
			notice: null,
		}
	},
	methods: {
		async onToggle(value) {
			this.saving = true
			this.notice = null
			try {
				const { data } = await axios.post(generateUrl('/apps/whiteboard/settings/personal'), {
					autoUploadOnDisconnect: value,
				})
				this.autoUploadOnDisconnect = !!data.autoUploadOnDisconnect
				this.notice = {
					type: 'success',
					message: t('whiteboard', 'Recording preference saved.'),
				}
			} catch (error) {
				showError(t('whiteboard', 'Failed to save recording preference.'))
			} finally {
				this.saving = false
			}
		},
	},
}
</script>

<style scoped>
.settings-help {
	color: var(--color-text-maxcontrast);
	margin-bottom: 12px;
}

.settings-note {
	margin-top: 12px;
}
</style>
