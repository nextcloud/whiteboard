<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="overall-stats-wrapper">
		<div class="row">
			<div class="chart-card">
				<h4>Total active users</h4>
				<h3>{{ totalActiveUsers }}</h3>
			</div>
			<div class="chart-card">
				<h4>Total boards</h4>
				<h3>{{ totalBoards }}</h3>
			</div>
			<div class="chart-card">
				<h4>Total size</h4>
				<h3>{{ totalSize }}</h3>
			</div>
			<div class="chart-card">
				<h4>Total elements</h4>
				<h3>{{ totalElements }}</h3>
			</div>
		</div>
		<br>

		<div class="row">
			<div class="chart-card" style="width: 100%">
				<h4>Average boards per user</h4>
				<h3>{{ averageBoardsPerUser }}</h3>
			</div>
		</div>
	</div>
</template>
<script>
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { formatSizeInBytes } from '../utils.ts'

export default {
	name: 'SummaryNumbers',
	data() {
		return {
			loading: false,
			totalActiveUsers: 0,
			totalBoards: 0,
			totalSizeInBytes: 0,
			totalElements: 0,
			averageBoardsPerUser: 0,
		}
	},
	computed: {
		totalSize() {
			return formatSizeInBytes(this.totalSizeInBytes)
		},
	},
	mounted() {
		this.fetchData()
	},
	methods: {
		async fetchData() {
			this.loading = true
			try {
				const { data } = await axios.get(generateUrl('/apps/whiteboard/stats/summary'))
				this.totalActiveUsers = data.totalActiveUsers
				this.totalBoards = data.totalBoards
				this.totalSizeInBytes = data.totalSize
				this.totalElements = data.totalElements
				this.averageBoardsPerUser = data.averageBoardsPerUser.toFixed(2)
			} catch (error) {
				console.error(error)
			}
			this.loading = false
		},
	},
}
</script>
<style scoped>
.overall-stats-wrapper .row {
	display: flex;
	gap: 20px;
	justify-content: space-between;
}
.chart-card {
	padding: 0 16px 16px;
	border-radius: 8px;
	border: 1px solid;
	width: 25%;
}
</style>
