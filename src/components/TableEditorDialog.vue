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
			hasEnsuredTextStyles: false,
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
				await this.ensureTextEditorStyles()
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
		async ensureTextEditorStyles() {
			if (this.hasEnsuredTextStyles) {
				return
			}
			this.hasEnsuredTextStyles = true

			if (!window.OCA?.Text?.createEditor) {
				return
			}

			const hasProseMirrorCss = () => {
				return Array.from(document.styleSheets).some((sheet) => {
					try {
						return Array.from(sheet.cssRules).some((rule) => rule.selectorText?.includes('.ProseMirror'))
					} catch (error) {
						return false
					}
				})
			}

			if (hasProseMirrorCss()) {
				return
			}

			const container = document.createElement('div')
			container.setAttribute('aria-hidden', 'true')
			container.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
			document.body.appendChild(container)

			try {
				const preloader = await window.OCA.Text.createEditor({
					el: container,
					content: '|  |\n| --- |\n|  |\n',
					readOnly: true,
					autofocus: false,
				})
				preloader?.destroy?.()
			} catch (error) {
				console.warn('Failed to preload Text editor styles:', error)
			} finally {
				container.remove()
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

				// helper function to get cell content while preserving line breaks
				const getCellContent = (cell) => {
					const clone = cell.cloneNode(true)
					const brs = clone.querySelectorAll('br')
					brs.forEach(br => {
						br.replaceWith(document.createTextNode('<br>'))
					})
					return clone.textContent.trim().replace(/\|/g, '\\|')
				}

				// Process first row as header
				const firstRow = rows[0]
				const headerCells = Array.from(firstRow.querySelectorAll('th, td'))
				const headers = headerCells.map(cell => getCellContent(cell))
				markdown += '| ' + headers.join(' | ') + ' |\n'

				// Add separator
				markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n'

				// Process remaining rows as body
				for (let i = 1; i < rows.length; i++) {
					const cells = Array.from(rows[i].querySelectorAll('td, th'))
					const values = cells.map(cell => getCellContent(cell))
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

	// Fallback styles for Text's table editor when prosemirror.scss isn't loaded
	:deep(.ProseMirror) {
		height: 100%;
		position: relative;
		word-wrap: break-word;
		width: 100%;
		white-space: pre-wrap;
		-webkit-font-variant-ligatures: none;
		font-variant-ligatures: none;
		padding: 4px 8px 200px 14px;
		line-height: 150%;
		font-size: var(--default-font-size);
		outline: none;
		color: var(--color-main-text);
		background-color: transparent;
	}

	:deep(.ProseMirror[contenteditable]),
	:deep(.ProseMirror [contenteditable]) {
		width: 100%;
		background-color: transparent;
		color: var(--color-main-text);
		opacity: 1;
		-webkit-user-select: text;
		user-select: text;
		font-size: var(--default-font-size);
	}

	:deep(.ProseMirror[contenteditable]:not(.collaboration-cursor__caret)),
	:deep(.ProseMirror [contenteditable]:not(.collaboration-cursor__caret)) {
		border: none !important;
	}

	:deep(.ProseMirror[contenteditable]:focus),
	:deep(.ProseMirror[contenteditable]:focus-visible),
	:deep(.ProseMirror [contenteditable]:focus),
	:deep(.ProseMirror [contenteditable]:focus-visible) {
		box-shadow: none !important;
	}

	:deep(.table-wrapper) {
		width: 100%;
	}

	:deep(.ProseMirror table) {
		border-spacing: 0;
		width: calc(100% - 50px);
		table-layout: auto;
		white-space: normal;
		margin-bottom: 1em;
	}

	:deep(.ProseMirror table td),
	:deep(.ProseMirror table th) {
		border: 1px solid var(--color-border);
		border-left: 0;
		vertical-align: top;
		max-width: 100%;
	}

	:deep(.ProseMirror table td:first-child),
	:deep(.ProseMirror table th:first-child) {
		border-left: 1px solid var(--color-border);
	}

	:deep(.ProseMirror table td) {
		padding: 0.5em 0.75em;
		border-top: 0;
		color: var(--color-main-text);
	}

	:deep(.ProseMirror table th) {
		padding: 0 0 0 0.75em;
		font-weight: normal;
		border-bottom-color: var(--color-border-dark);
		color: var(--color-text-maxcontrast);
	}

	:deep(.ProseMirror table th > div) {
		display: flex;
	}

	:deep(.ProseMirror table tr) {
		background-color: var(--color-main-background);
	}

	:deep(.ProseMirror table tr:hover),
	:deep(.ProseMirror table tr:active),
	:deep(.ProseMirror table tr:focus) {
		background-color: var(--color-primary-element-light);
	}

	:deep(.ProseMirror table tr:first-child th:first-child) {
		border-top-left-radius: var(--border-radius);
	}

	:deep(.ProseMirror table tr:first-child th:last-child) {
		border-top-right-radius: var(--border-radius);
	}

	:deep(.ProseMirror table tr:last-child td:first-child) {
		border-bottom-left-radius: var(--border-radius);
	}

	:deep(.ProseMirror table tr:last-child td:last-child) {
		border-bottom-right-radius: var(--border-radius);
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
