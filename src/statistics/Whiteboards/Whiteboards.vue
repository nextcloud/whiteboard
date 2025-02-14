<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div>
		<StoredBoardsChart />
		<br>
		<StoredBoardsTable />
	</div>
</template>

<script>
import StoredBoardsChart from './StoredBoardsChart.vue'
import StoredBoardsTable from './StoredBoardsTable.vue'

export default {
	name: 'Whiteboards',
	components: { StoredBoardsTable, StoredBoardsChart },
}
</script>
