<!--
  - SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script>
import { NcButton, NcModal, NcNoteCard } from '@nextcloud/vue'
import { defineComponent } from 'vue'
import { t } from '@nextcloud/l10n'

export default defineComponent({
	name: 'TableEditorDialog',
	components: {
		NcButton,
		NcModal,
		NcNoteCard,
	},
	props: {
		initialHtml: {
			type: String,
			default: '',
		},
	},
	emits: ['cancel', 'submit'],
	data() {
		return {
			show: true,
			editor: null,
			isLoading: true,
			error: null,
			currentHtml: this.initialHtml || '',
		}
	},
	computed: {
		isEditing() {
			return Boolean(this.initialHtml)
		},
	},
	async mounted() {
		await this.$nextTick()
		await this.initializeEditor()
	},
	beforeUnmount() {
		this.destroyEditor()
	},
	methods: {
		t,
		async initializeEditor() {
			try {
				// Check if Text app is available
				if (!window.OCA?.Text) {
					this.error = t('whiteboard', 'Nextcloud Text app is not available. Please install and enable it.')
					this.isLoading = false
					return
				}

				const editorContainer = this.$refs.editorContainer
				if (!editorContainer) {
					this.error = t('whiteboard', 'Editor container not found')
					this.isLoading = false
					return
				}

				// Convert HTML to markdown for the Text editor input
				let contentForEditor = this.currentHtml && this.currentHtml.trim()
					? this.generateMarkdownFromHtml(this.currentHtml)
					: ''

				// If no content provided, create a minimal table with header and one body row
				// This ensures the table editor recognizes it as a proper table with columns
				if (!contentForEditor) {
					contentForEditor = '|  |\n| --- |\n|  |\n'
				}
				// Use the dedicated createTable function for table-only editing
				this.editor = await window.OCA.Text.createTable({
					el: editorContainer,
					content: contentForEditor,
				})

				this.isLoading = false
				// Focus the editor after a short delay
				setTimeout(() => {
					if (this.editor) {
						this.editor.focus?.()
					}
				}, 100)
			} catch (error) {
				console.error('Failed to initialize Text editor:', error)
				this.error = t('whiteboard', 'Failed to load the editor: {error}', { error: error.message })
				this.isLoading = false
			}
		},

		onCancel() {
			this.show = false
			this.$emit('cancel')
		},

		async onInsert() {
			if (!this.editor) {
				this.error = t('whiteboard', 'Editor not initialized')
				return
			}

			try {
				// Use Text app's getHTML() to extract clean HTML from Tiptap editor
				const fullHtml = this.editor.getHTML()
				if (!fullHtml) {
					this.error = t('whiteboard', 'Failed to get editor content')
					return
				}

				// Parse the HTML and extract just the table element
				const parser = new DOMParser()
				const doc = parser.parseFromString(fullHtml, 'text/html')
				const table = doc.querySelector('table')

				if (!table) {
					this.error = t('whiteboard', 'No table found in editor content')
					return
				}

				this.$emit('submit', {
					html: table.outerHTML.trim(),
				})

				this.show = false
			} catch (error) {
				console.error('Failed to get editor content:', error)
				this.error = t('whiteboard', 'Failed to get content: {error}', { error: error.message })
			}
		},

		/**
		 * Generate simple markdown from HTML table
		 * This is a basic conversion - not perfect but sufficient for Text editor input
		 * @param html - The HTML table content to convert
		 */
		generateMarkdownFromHtml(html) {
			try {
				const parser = new DOMParser()
				const doc = parser.parseFromString(html, 'text/html')
				const table = doc.querySelector('table')

				if (!table) {
					return ''
				}

				const rows = Array.from(table.querySelectorAll('tr'))
				if (rows.length === 0) {
					return ''
				}

				let markdown = ''

				// Process first row as header
				const firstRow = rows[0]
				const headerCells = Array.from(firstRow.querySelectorAll('th, td'))
				// Escape pipe characters in cell content for markdown
				const headers = headerCells.map(cell => cell.textContent.trim().replace(/\|/g, '\\|'))
				markdown += '| ' + headers.join(' | ') + ' |\n'

				// Add separator
				markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n'

				// Process remaining rows as body
				for (let i = 1; i < rows.length; i++) {
					const cells = Array.from(rows[i].querySelectorAll('td, th'))
					// Escape pipe characters in cell content for markdown
					const values = cells.map(cell => cell.textContent.trim().replace(/\|/g, '\\|'))
					markdown += '| ' + values.join(' | ') + ' |\n'
				}

				return markdown
			} catch (error) {
				console.error('Failed to generate markdown from HTML:', error)
				return ''
			}
		},

		destroyEditor() {
			if (this.editor) {
				try {
					this.editor.destroy()
				} catch (error) {
					console.error('Error destroying editor:', error)
				}
				this.editor = null
			}
		},
	},
})
</script>

<template>
	<NcModal v-if="show"
		:can-close="true"
		size="large"
		@close="onCancel">
		<div class="table-editor-dialog">
			<div class="editor-header">
				<h2>
					{{ isEditing ? t('whiteboard', 'Edit Table') : t('whiteboard', 'Insert Table') }}
				</h2>
			</div>

			<NcNoteCard v-if="error" type="error">
				{{ error }}
			</NcNoteCard>

			<div v-if="isLoading" class="loading-message">
				{{ t('whiteboard', 'Loading editor…') }}
			</div>

			<div class="editor-container">
				<div ref="editorContainer" />
			</div>

			<div class="dialog-buttons">
				<NcButton @click="onCancel">
					{{ t('whiteboard', 'Cancel') }}
				</NcButton>
				<NcButton type="primary" :disabled="isLoading || error" @click="onInsert">
					{{ isEditing ? t('whiteboard', 'Update') : t('whiteboard', 'Insert') }}
				</NcButton>
			</div>
		</div>
	</NcModal>
</template>

<style scoped lang="scss">
.table-editor-dialog {
	display: flex;
	flex-direction: column;
	min-height: 500px;
}

.editor-header {
	margin-bottom: 16px;
	padding: 20px;

	h2 {
		margin: 0 0 8px 0;
	}

	p {
		margin: 0;
		color: var(--color-text-maxcontrast);
		font-size: 14px;
	}
}

.loading-message {
	padding: 40px;
	text-align: center;
	color: var(--color-text-maxcontrast);
}

.editor-container {
	flex: 1;
	min-height: 400px;
	border-radius: var(--border-radius);
	overflow: hidden;

	// Hide block manipulation controls from Text editor
	// These aren't needed in table-only editing mode
	:deep(.floating-buttons),
	:deep(.drag-handle),
	:deep(.drag-button),
	:deep(.table-settings) {
		display: none !important;
	}
}

.dialog-buttons {
	padding: 20px;
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 16px;
	padding-top: 16px;
	border-top: 1px solid var(--color-border);
}
</style>
