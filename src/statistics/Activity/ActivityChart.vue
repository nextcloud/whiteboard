<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="activity-chart-wrapper">
		<h4>{{ t('whiteboard', 'Activity') }}</h4>
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
				chart-id="activity"
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
	name: 'ActivityChart',
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
						label: t('whiteboatd', 'Created'),
						backgroundColor: '#7af979',
						borderColor: '#7af979',
						data: [],
					},
					{
						label: t('whiteboatd', 'Opened'),
						backgroundColor: '#7acbf9',
						borderColor: '#7acbf9',
						data: [],
					},
					{
						label: t('whiteboatd', 'Updated'),
						backgroundColor: '#f8e979',
						borderColor: '#f8e979',
						data: [],
					},
					{
						label: t('whiteboatd', 'Deleted'),
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
				label: 'Last hour',
			},
			timeFilterOptions: [
				{
					id: 'last-hour',
					label: 'Last hour',
				},
				{
					id: 'last-24h',
					label: 'Last 24 hours',
				},
				{
					id: 'last-7days',
					label: 'Last 7 days',
				},
				{
					id: 'last-30-days',
					label: 'Last 30 days',
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
				const { data } = await axios.get(generateUrl('/apps/whiteboard/stats/activities-count'), {
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
			this.chartData.datasets[0].data = this.filteredData.map((item) => item.created || 0)
			this.chartData.datasets[1].data = this.filteredData.map((item) => item.opened || 0)
			this.chartData.datasets[2].data = this.filteredData.map((item) => item.updated || 0)
			this.chartData.datasets[3].data = this.filteredData.map((item) => item.deleted || 0)
		},
	},
}
</script>

<style scoped>
.activity-chart-wrapper {
	padding: 0 16px 16px;
	border-radius: 8px;
	border: 1px solid;
}
</style>
