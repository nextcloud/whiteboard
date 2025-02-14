<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div>
		<SummaryNumbers />
		<br>
		<UserStats />
		<br>
		<Activity />
		<br>
		<Whiteboards />
	</div>
</template>
<script>
import SummaryNumbers from './SummaryNumbers.vue'
import UserStats from './UserStats/UserStats.vue'
import Activity from './Activity/Activity.vue'
import Whiteboards from './Whiteboards/Whiteboards.vue'

export default {
	name: 'Statistics',
	components: {
		Whiteboards,
		Activity,
		UserStats,
		SummaryNumbers,
	},
	data() {
		return {}
	},
}
</script>
<style scoped>
:deep(.relative-wrapper) {
	position: relative;
}
:deep(.relative-wrapper .loading-icon) {
	position: absolute;
	width: 100%;
	height: 100%;
}
:deep(.disabled-container) {
	opacity: 0.3;
	pointer-events: none;
}
</style>
