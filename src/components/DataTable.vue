<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="data-table-wrapper">
		<table>
			<thead>
				<tr>
					<th v-for="column in columns"
						:key="column.field"
						class="sort-able"
						@click="onClickSortColumn(column.field)">
						{{ column.label }}
						<span v-if="orderBy === column.field">{{ orderDir === 'asc' ? '▲' : '▼' }}</span>
					</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="item in items" :key="item.uid">
					<td v-for="column in columns" :key="column.field">
						{{ formatColumnValue(column, item[column.field]) }}
					</td>
				</tr>
			</tbody>
		</table>

		<div class="paging-wrapper">
			<button :disabled="offset === 0" @click="onClickPrevPage">
				{{ t('whiteboard', 'Prev') }}
			</button>
			<div class="pages">
				<template v-for="page in pages">
					<button v-if="page !== '...'"
						:key="page"
						:class="{ active: page === currentPage }"
						@click="onClickPage(page)">
						{{ page }}
					</button>
					<span v-else :key="page">...</span>
				</template>
			</div>
			<button :disabled="offset + perPage >= totalCount" @click="onClickNextPage">
				{{ t('whiteboard', 'Next') }}
			</button>
		</div>
	</div>
</template>

<script>
import { formatSizeInBytes } from '../utils.ts'

export default {
	name: 'DataTable',
	props: {
		columns: {
			type: Array,
			required: true,
		},
		items: {
			type: Array,
			required: true,
		},
		perPage: {
			type: Number,
			default: 10,
		},
		totalCount: {
			type: Number,
			required: true,
		},
		offset: {
			type: Number,
			default: 0,
		},
		orderBy: {
			type: String,
			default: '',
		},
		orderDir: {
			type: String,
			default: '',
		},
	},
	computed: {
		pages() {
			const totalPages = Math.ceil(this.totalCount / this.perPage)
			const currentPage = this.currentPage
			const pages = []

			if (totalPages <= 3) {
				for (let i = 1; i <= totalPages; i++) {
					pages.push(i)
				}
			} else {
				if (currentPage > 2) {
					pages.push(1)
					if (currentPage > 3) {
						pages.push('...')
					}
				}

				const startPage = Math.max(1, currentPage - 1)
				const endPage = Math.min(totalPages, currentPage + 1)

				for (let i = startPage; i <= endPage; i++) {
					pages.push(i)
				}

				if (currentPage < totalPages - 1) {
					if (currentPage < totalPages - 2) {
						pages.push('...')
					}
					pages.push(totalPages)
				}
			}

			return pages
		},
		currentPage() {
			return this.offset / this.perPage + 1
		},
	},
	watch: {},
	methods: {
		onClickNextPage() {
			this.$emit('page', this.offset + this.perPage)
		},
		onClickPrevPage() {
			this.$emit('page', this.offset - this.perPage)
		},
		onClickPage(page) {
			this.$emit('page', (page - 1) * this.perPage)
		},
		onClickSortColumn(column) {
			const newOrderBy = column
			let newOrderDir = 'asc'

			if (this.orderBy === column) {
				newOrderDir = this.orderDir === 'asc' ? 'desc' : 'asc'
			}

			this.$emit('sort', {
				orderBy: newOrderBy,
				orderDir: newOrderDir,
			})
		},
		formatColumnValue(column, value) {
			if (column.format === 'size') {
				return formatSizeInBytes(value)
			}

			if (column.format === 'datetime') {
				return new Date(value * 1000).toLocaleString()
			}

			return value
		},
	},
}
</script>

<style scoped>
.data-table-wrapper {
	overflow-x: auto;
}
table {
	width: 100%;
	border-collapse: collapse;
}
th, td {
	padding: 8px;
	text-align: left;
}
th {
	font-weight: bold;
}
th.sort-able {
	cursor: pointer;
}
.paging-wrapper {
	display: flex;
	justify-content: center;
	margin-top: 10px;
}
.paging-wrapper button {
	padding: 5px 10px;
	margin: 0 5px;
	border: 1px solid;
	border-radius: 5px;
	cursor: pointer;
}
.paging-wrapper button:disabled {
	cursor: not-allowed;
}
.pages button.active {
	background-color: var(--color-primary);
	color: white;
}
.pages button {
	padding: 5px 10px;
	margin: 0 5px;
	border: 1px solid;
	border-radius: 5px;
	cursor: pointer;
}
.pages button:hover {
	background-color: var(--color-primary);
	color: white;
}
</style>
