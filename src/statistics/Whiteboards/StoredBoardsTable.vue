<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="stored-boards-table-wrapper">
		<h4>{{ t('whiteboard', 'Stored whiteboards') }}</h4>
		<div class="filter-wrapper">
			<NcTextField :label="t('whiteboard', 'Search')" :value.sync="search" />
		</div>
		<div class="relative-wrapper">
			<NcLoadingIcon v-if="loading" :size="64" />
			<DataTable :class="{ 'disabled-container': loading }"
				:columns="columns"
				:items="items"
				:total-count="totalCount"
				:per-page="perPage"
				:offset="offset"
				:order-by="orderBy"
				:order-dir="orderDir"
				@sort="onSort"
				@page="onPage" />
		</div>
	</div>
</template>

<script>
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import DataTable from '../../components/DataTable.vue'
import { debounce } from '../../utils.ts'

export default {
	name: 'StoredBoardsTable',
	components: {
		DataTable,
		NcLoadingIcon,
		NcTextField,
	},
	data() {
		return {
			loading: false,
			search: '',
			orderBy: 'size',
			orderDir: 'desc',
			offset: 0,
			perPage: 10,
			items: [],
			totalCount: 0,
			columns: [
				{
					label: this.t('whiteboard', 'File ID'),
					field: 'fileid',
					sortable: true,
				},
				{
					label: this.t('whiteboard', 'User'),
					field: 'user',
					sortable: true,
				},
				{
					label: this.t('whiteboard', 'Elements'),
					field: 'elements',
					sortable: true,
				},
				{
					label: this.t('whiteboard', 'Size'),
					field: 'size',
					sortable: true,
					format: 'size',
				},
				{
					label: this.t('whiteboard', 'Modified time'),
					field: 'timestamp',
					sortable: true,
					format: 'datetime',
				},
			],
		}
	},
	watch: {
		search: debounce(function() {
			this.fetchData()
		}, 1000),
	},
	mounted() {
		this.fetchData()
	},
	methods: {
		async fetchData() {
			this.loading = true
			try {
				const response = await axios.get(generateUrl('/apps/whiteboard/stats/boards-info'), {
					params: {
						filter: {
							search: this.search,
						},
						orderBy: this.orderBy,
						orderDir: this.orderDir,
						offset: this.offset,
						limit: this.limit,
					},
				})
				const data = response?.data?.data || []
				this.items = data?.items || []
				this.totalCount = data?.totalCount || 0
			} catch (error) {
				console.error(error)
			}
			this.loading = false
		},
		onSort({ orderBy, orderDir }) {
			this.orderBy = orderBy
			this.orderDir = orderDir
			this.fetchData()
		},
		onPage(offset) {
			this.offset = offset
			this.fetchData()
		},
	},
}
</script>

<style scoped>
.stored-boards-table-wrapper {
	padding: 0 16px 16px;
	border-radius: 8px;
	border: 1px solid;
}
.filter-wrapper {
	display: flex;
	gap: 10px;
	margin-bottom: 10px;
}
</style>
