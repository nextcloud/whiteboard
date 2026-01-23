<!--
  - SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script>
import { NcEmojiPicker } from '@nextcloud/vue'
import { defineComponent } from 'vue'
import { mdiStickerEmoji } from '@mdi/js'
import { t } from '@nextcloud/l10n'

export default defineComponent({
	name: 'EmojiPickerButton',
	components: {
		NcEmojiPicker,
	},
	data() {
		return {
			mdiStickerEmoji,
		}
	},
	methods: {
		handleClick() {
			this.$emit('open')
		},
		onSelectEmoji(emoji) {
			this.$emit('selected', emoji)
		},
		t,
	},
})

</script>

<template>
	<NcEmojiPicker :aria-label="t('whiteboard', 'Add reaction')"
		:title="t('whiteboard', 'Add reaction')"
		@select-data="onSelectEmoji">
		<button class="dropdown-menu-button" @click="handleClick">
			<svg viewBox="0 0 24 24" role="presentation" style="width: 1.5rem; height: 1.5rem;">
				<path :d="mdiStickerEmoji" style="fill: currentcolor" />
			</svg>
		</button>
	</NcEmojiPicker>
</template>
