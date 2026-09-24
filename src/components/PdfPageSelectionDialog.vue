<!--
 - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<NcDialog :name="t('whiteboard', 'Import pages from \'{fileName}\'', { fileName })" @update:open="onOpenUpdate">
		<div class="pdf-page-selection" @keyup.enter="onSubmit">
			<div class="pdf-page-selection__preview-area">
				<div class="pdf-page-selection__preview-wrapper">
					<img
						v-if="previewDataUrl"
						:src="previewDataUrl"
						:alt="t('whiteboard', 'Preview of page {page}', { page: currentPreviewPage })"
						class="pdf-page-selection__preview"
						:class="{ 'pdf-page-selection__preview--loading': previewLoading }">
					<NcLoadingIcon v-if="previewLoading" class="pdf-page-selection__preview-spinner" />
					<p v-if="previewError && !previewLoading" class="pdf-page-selection__preview-error">
						{{ t('whiteboard', 'Preview unavailable for this page.') }}
					</p>
				</div>

				<div class="pdf-page-selection__nav">
					<NcButton
						variant="tertiary"
						:disabled="currentPreviewPage <= 1"
						:aria-label="t('whiteboard', 'Previous page')"
						@click="goToPage(currentPreviewPage - 1)">
						<template #icon>
							<NcIconSvgWrapper :path="mdiChevronLeft" />
						</template>
					</NcButton>

					<span class="pdf-page-selection__nav-label">
						{{ t('whiteboard', 'Page') }}
						<NcTextField
							:model-value="String(currentPreviewPage)"
							type="number"
							:min="1"
							:max="numPages"
							label-outside
							class="pdf-page-selection__nav-input"
							:label="t('whiteboard', 'Preview page number')"
							@update:model-value="onJumpToPage" />
						{{ t('whiteboard', 'of {numPages}', { numPages }) }}
					</span>

					<NcButton
						variant="tertiary"
						:disabled="currentPreviewPage >= numPages"
						:aria-label="t('whiteboard', 'Next page')"
						@click="goToPage(currentPreviewPage + 1)">
						<template #icon>
							<NcIconSvgWrapper :path="mdiChevronRight" />
						</template>
					</NcButton>
				</div>
			</div>

			<p>{{ t('whiteboard', 'This PDF has {numPages} pages.', { numPages }) }}</p>

			<NcCheckboxRadioSwitch
				v-model="selectionMode"
				type="radio"
				name="pdf-page-selection-mode"
				value="previewed">
				{{ t('whiteboard', 'Previewed page') }}
			</NcCheckboxRadioSwitch>
			<NcCheckboxRadioSwitch
				v-model="selectionMode"
				type="radio"
				name="pdf-page-selection-mode"
				value="all"
				:disabled="!isAllPagesAllowed">
				{{ t('whiteboard', 'All pages') }}
			</NcCheckboxRadioSwitch>
			<NcCheckboxRadioSwitch
				v-model="selectionMode"
				type="radio"
				name="pdf-page-selection-mode"
				value="range">
				{{ t('whiteboard', 'Page range') }}
			</NcCheckboxRadioSwitch>

			<NcNoteCard v-if="!isAllPagesAllowed" type="info" class="pdf-page-selection__hint">
				{{ t('whiteboard', 'This document has more than {max} pages, so it can\'t be imported all at once - choose a page range of up to {max} pages instead.', { max: MAX_PDF_PAGES }) }}
			</NcNoteCard>

			<div v-if="selectionMode === 'range'" class="pdf-page-selection__range">
				<NcTextField
					v-model.number="rangeStart"
					type="number"
					:min="1"
					:max="numPages"
					:label="t('whiteboard', 'Start page')" />
				<NcTextField
					v-model.number="rangeEnd"
					type="number"
					:min="1"
					:max="numPages"
					:label="t('whiteboard', 'End page')" />
			</div>

			<NcNoteCard v-if="rangeError" type="error" class="pdf-page-selection__hint">
				{{ rangeError }}
			</NcNoteCard>
		</div>

		<template #actions>
			<NcButton :disabled="!isValid" @click="onSubmit">
				{{ t('whiteboard', 'Import') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import { mdiChevronLeft, mdiChevronRight } from '@mdi/js'
import { translate as t } from '@nextcloud/l10n'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcIconSvgWrapper from '@nextcloud/vue/components/NcIconSvgWrapper'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import { canImportAllPages, getPageRangeError, MAX_PDF_PAGES } from '../utils/pdfPageSelection.ts'

export default {
	name: 'PdfPageSelectionDialog',
	components: {
		NcDialog,
		NcCheckboxRadioSwitch,
		NcTextField,
		NcNoteCard,
		NcButton,
		NcIconSvgWrapper,
		NcLoadingIcon,
	},

	props: {
		fileName: {
			type: String,
			required: true,
		},

		numPages: {
			type: Number,
			required: true,
		},

		/**
		 * Resolves with a preview data URL for a page. The caller owns the open
		 * PDF document, so this component never touches pdfjs-dist.
		 */
		renderPreview: {
			type: Function,
			required: true,
		},
	},

	emits: ['cancel', 'submit'],

	data() {
		return {
			mdiChevronLeft,
			mdiChevronRight,
			MAX_PDF_PAGES,
			// The only option that is always valid without further input.
			selectionMode: 'previewed',
			rangeStart: 1,
			rangeEnd: Math.min(this.numPages, MAX_PDF_PAGES),
			currentPreviewPage: 1,
			previewDataUrl: null,
			previewLoading: false,
			previewError: false,
			previewRequestSeq: 0,
		}
	},

	computed: {
		isAllPagesAllowed() {
			return canImportAllPages(this.numPages)
		},

		effectiveRange() {
			if (this.selectionMode === 'all') {
				return { start: 1, end: this.numPages }
			}
			if (this.selectionMode === 'previewed') {
				return { start: this.currentPreviewPage, end: this.currentPreviewPage }
			}
			return { start: this.rangeStart, end: this.rangeEnd }
		},

		rangeError() {
			if (this.selectionMode !== 'range') {
				return null
			}

			const { start, end } = this.effectiveRange
			const error = getPageRangeError(start, end, this.numPages)

			switch (error?.reason) {
				case 'start':
					return t('whiteboard', 'Start page must be between 1 and {numPages}.', { numPages: this.numPages })
				case 'end':
					return t('whiteboard', 'End page must be between {start} and {numPages}.', { start, numPages: this.numPages })
				case 'tooManyPages':
					return t('whiteboard', 'You can import at most {max} pages at once (selected: {count}).', { max: MAX_PDF_PAGES, count: error.count })
				default:
					return null
			}
		},

		isValid() {
			if (this.selectionMode === 'all') {
				return this.isAllPagesAllowed
			}
			if (this.selectionMode === 'previewed') {
				return true
			}
			return this.rangeError === null
		},
	},

	mounted() {
		this.loadPreview(this.currentPreviewPage)
	},

	methods: {
		t,

		goToPage(pageNumber) {
			if (pageNumber < 1 || pageNumber > this.numPages || pageNumber === this.currentPreviewPage) {
				return
			}
			this.currentPreviewPage = pageNumber
			this.loadPreview(pageNumber)
		},

		onJumpToPage(value) {
			const pageNumber = Number.parseInt(value, 10)
			if (Number.isNaN(pageNumber)) {
				return
			}
			this.goToPage(pageNumber)
		},

		/**
		 * Renders a page's preview. Only the latest request's result is applied,
		 * so fast navigation never shows a stale page.
		 *
		 * @param {number} pageNumber - The page to render a preview for.
		 */
		async loadPreview(pageNumber) {
			const requestSeq = ++this.previewRequestSeq
			this.previewLoading = true
			this.previewError = false

			try {
				const dataUrl = await this.renderPreview(pageNumber)
				if (requestSeq !== this.previewRequestSeq) {
					return
				}
				this.previewDataUrl = dataUrl
			} catch {
				if (requestSeq !== this.previewRequestSeq) {
					return
				}
				this.previewError = true
			} finally {
				if (requestSeq === this.previewRequestSeq) {
					this.previewLoading = false
				}
			}
		},

		onSubmit() {
			if (!this.isValid) {
				return
			}
			this.$emit('submit', this.effectiveRange)
		},

		onOpenUpdate(open) {
			if (!open) {
				this.$emit('cancel')
			}
		},
	},
}
</script>

<style scoped>
.pdf-page-selection__preview-wrapper {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 100px;
}

.pdf-page-selection__preview {
	display: block;
	max-width: 100%;
	max-height: 240px;
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius);
	transition: opacity 0.1s ease-in-out;
}

.pdf-page-selection__preview--loading {
	opacity: 0.5;
}

.pdf-page-selection__preview-spinner {
	position: absolute;
}

.pdf-page-selection__preview-error {
	color: var(--color-text-maxcontrast);
}

.pdf-page-selection__nav {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	margin: 8px 0 12px;
}

.pdf-page-selection__nav-label {
	display: flex;
	align-items: center;
	gap: 4px;
}

.pdf-page-selection__nav-input {
	width: 60px;
}

.pdf-page-selection__range {
	display: flex;
	gap: 12px;
	margin-top: 8px;
}

.pdf-page-selection__hint {
	margin-top: 8px;
}
</style>
