<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="user-stats-wrapper">
		<ActiveUsersChart />
		<br>
		<UsersTable />
	</div>
</template>

<script>
import ActiveUsersChart from './ActiveUsersChart.vue'
import UsersTable from './UsersTable.vue'

export default {
	name: 'UserStats',
	components: { UsersTable, ActiveUsersChart },
}
</script>
