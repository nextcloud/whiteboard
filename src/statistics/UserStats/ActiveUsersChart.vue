<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="active-users-wrapper">
		<h4>{{ t('whiteboard', 'Active users') }}</h4>
		<div class="filters-wrapper">
			<NcSelect v-model="selectedTimeFilter"
				:input-label="t('whiteboard', 'Time')"
				:options="timeFilterOptions" />
		</div>
		<div class="relative-wrapper">
			<NcLoadingIcon v-if="loading" :size="64" />
			<LineChartGenerator :class="{ 'disabled-container': loading }"
				:chart-options="chartOptions"
				:chart-data="chartData"
				chart-id="active-users"
				:dataset-id-key="datasetIdKey"
				:width="400"
				:height="400" />
		</div>
	</div>
</template>

<script>
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { Line as LineChartGenerator } from 'vue-chartjs/legacy'
import NcSelect from '@nextcloud/vue/dist/Components/NcSelect.js'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import { getLabelsFromTimeFrames, getTimeFrames } from '../../utils.ts'

import {
	Chart as ChartJS,
	Title,
	Tooltip,
	Legend,
	LineElement,
	LinearScale,
	CategoryScale,
	PointElement,
} from 'chart.js'

ChartJS.register(
	Title,
	Tooltip,
	Legend,
	LineElement,
	LinearScale,
	CategoryScale,
	PointElement,
)

export default {
	name: 'ActiveUsersChart',
	components: {
		NcLoadingIcon,
		LineChartGenerator,
		NcSelect,
	},
	data() {
		return {
			loading: false,
			datasetIdKey: 'label',
			filteredData: [],
			chartData: {
				labels: [],
				datasets: [
					{
						label: t('whiteboatd', 'Average active users'),
						backgroundColor: '#f87979',
						borderColor: '#f87979',
						data: [],
					},
				],
			},
			chartOptions: {
				responsive: true,
				maintainAspectRatio: false,
			},
			selectedTimeFilter: {
				id: 'last-hour',
				label: t('whiteboatd', 'Last hour'),
			},
			timeFilterOptions: [
				{
					id: 'last-hour',
					label: t('whiteboatd', 'Last hour'),
				},
				{
					id: 'last-24h',
					label: t('whiteboatd', 'Last 24 hours'),
				},
				{
					id: 'last-7days',
					label: t('whiteboatd', 'Last 7 days'),
				},
				{
					id: 'last-30-days',
					label: t('whiteboatd', 'Last 30 days'),
				},
			],
		}
	},
	computed: {
		filterTimeFrames() {
			return getTimeFrames(this.selectedTimeFilter.id)
		},
	},
	watch: {
		selectedTimeFilter() {
			this.fetchData()
		},
	},
	mounted() {
		this.fetchData()
	},
	methods: {
		async fetchData() {
			this.loading = true
			try {
				const { data } = await axios.get(generateUrl('/apps/whiteboard/stats/average-active-users'), {
					params: {
						time_frames: this.filterTimeFrames,
					},
				})
				this.filteredData = data.data
				this.renderChartData()
			} catch (error) {
				console.error(error)
			} finally {
				this.loading = false
			}
		},
		renderChartData() {
			if (!this.filteredData.length) {
				this.chartData.labels = []
				this.chartData.datasets[0].data = []
				return
			}

			this.chartData.labels = getLabelsFromTimeFrames(this.filteredData, this.selectedTimeFilter.id)
			this.chartData.datasets[0].data = this.filteredData.map((item) => item.value)
		},
	},
}
</script>

<style scoped>
.active-users-wrapper {
	padding: 0 16px 16px;
	border-radius: 8px;
	border: 1px solid;
}
</style>
