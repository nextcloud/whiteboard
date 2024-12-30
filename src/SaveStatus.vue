/**
* SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
* SPDX-License-Identifier: AGPL-3.0-or-later
*/
<template>
	<NcButton type="tertiary" @click="onClick">
		<template #icon>
			<NcSavingIndicatorIcon :saving="saving" />
		</template>
	</NcButton>
</template>

<script>
import { NcButton, NcSavingIndicatorIcon } from '@nextcloud/vue'
export default {
	name: 'SaveStatus',
	components: {
		NcButton,
		NcSavingIndicatorIcon,
	},
	props: {
		saving: {
			type: Boolean,
			default: false,
		},
		onClick: {
			type: Function,
			default: () => { },
		},
	},
}
</script>
