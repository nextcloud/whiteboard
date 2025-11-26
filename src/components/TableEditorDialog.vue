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
		initialMarkdown: {
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
			currentMarkdown: this.initialMarkdown || this.getDefaultTable(),
		}
	},
	computed: {
		isEditing() {
			return Boolean(this.initialMarkdown)
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

				// Create the Text editor instance with callbacks
				this.editor = await window.OCA.Text.createEditor({
					el: editorContainer,
					content: this.currentMarkdown,
					// Track content changes
					onUpdate: ({ markdown }) => {
						this.currentMarkdown = markdown
					},
					onCreate: ({ markdown }) => {
						this.currentMarkdown = markdown
					},
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

		getDefaultTable() {
			return `| Column 1 | Column 2 | Column 3 |
| -------- | -------- | -------- |
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |`
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
				// Use the tracked markdown content
				const markdown = this.currentMarkdown

				if (!markdown || !markdown.trim()) {
					this.error = t('whiteboard', 'Please enter some table content')
					return
				}

				this.$emit('submit', {
					markdown: markdown.trim(),
				})

				this.show = false
			} catch (error) {
				console.error('Failed to get editor content:', error)
				this.error = t('whiteboard', 'Failed to get content: {error}', { error: error.message })
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
				<p>{{ t('whiteboard', 'Use the table feature in the editor to create or edit your table') }}</p>
			</div>

			<NcNoteCard v-if="error" type="error">
				{{ error }}
			</NcNoteCard>

			<div v-if="isLoading" class="loading-message">
				{{ t('whiteboard', 'Loading editor…') }}
			</div>

			<div ref="editorContainer" class="editor-container" />

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
	padding: 20px;
	display: flex;
	flex-direction: column;
	min-height: 500px;
}

.editor-header {
	margin-bottom: 16px;

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
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius);
	overflow: hidden;
}

.dialog-buttons {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 16px;
	padding-top: 16px;
	border-top: 1px solid var(--color-border);
}
</style>
