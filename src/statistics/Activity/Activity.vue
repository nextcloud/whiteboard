<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="activity-wrapper">
		<ActivityChart />
		<br>
		<ActivityTable />
	</div>
</template>
<script>
import ActivityChart from './ActivityChart.vue'
import ActivityTable from './ActivityTable.vue'

export default {
	name: 'Activity',
	components: { ActivityTable, ActivityChart },
}
</script>
