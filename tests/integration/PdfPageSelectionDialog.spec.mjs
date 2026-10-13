/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PdfPageSelectionDialog from '../../src/components/PdfPageSelectionDialog.vue'
import { MAX_PDF_PAGES } from '../../src/utils/pdfPageSelection.ts'

describe('PdfPageSelectionDialog', () => {
	let wrapper

	async function mountDialog(props = {}) {
		wrapper = mount(PdfPageSelectionDialog, {
			props: {
				fileName: 'slides.pdf',
				numPages: 5,
				renderPreview: vi.fn(async (pageNumber) => `data:image/png;base64,page${pageNumber}`),
				...props,
			},
			attachTo: document.body,
		})
		await flushPromises()
		return wrapper
	}

	// NcDialog teleports its content to <body>, outside the wrapper.
	const find = (selector) => document.body.querySelector(selector)
	const button = (label) => Array.from(document.body.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === label || element.textContent.trim() === label)
	const radio = (value) => find(`input[type=radio][value="${value}"]`)

	async function pressEnter(element) {
		element.focus()
		for (const type of ['keydown', 'keypress', 'keyup']) {
			element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
		}
		await flushPromises()
	}

	async function click(element) {
		element.click()
		await flushPromises()
	}

	async function type(input, value) {
		input.value = String(value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
		await flushPromises()
	}

	afterEach(() => {
		wrapper?.unmount()
		document.body.innerHTML = ''
	})

	it('shows the first page\'s preview and submits it by default', async () => {
		await mountDialog()

		expect(find('.pdf-page-selection__preview').getAttribute('src')).toBe('data:image/png;base64,page1')
		expect(radio('previewed').checked).toBe(true)

		await click(button('Import'))
		expect(wrapper.emitted('submit')).toEqual([[{ start: 1, end: 1 }]])
	})

	it('submits the page being previewed after browsing', async () => {
		await mountDialog()

		await click(button('Next page'))
		await click(button('Next page'))
		await click(button('Previous page'))

		expect(find('.pdf-page-selection__preview').getAttribute('src')).toBe('data:image/png;base64,page2')
		await click(button('Import'))
		expect(wrapper.emitted('submit')).toEqual([[{ start: 2, end: 2 }]])
	})

	it('does not submit on Enter on "Next page", a radio button or a page number field', async () => {
		await mountDialog()

		await pressEnter(button('Next page'))
		await pressEnter(radio('all'))
		await click(radio('range'))
		await pressEnter(find('.pdf-page-selection__range input'))
		await pressEnter(find('.pdf-page-selection__nav-input input'))

		expect(wrapper.emitted('submit')).toBeUndefined()
	})

	it('submits on Enter on the Import button', async () => {
		await mountDialog()
		const importButton = button('Import')

		expect(importButton.getAttribute('type')).toBe('button')
		// Browsers turn Enter on a focused button into a click.
		importButton.focus()
		await click(importButton)

		expect(wrapper.emitted('submit')).toEqual([[{ start: 1, end: 1 }]])
	})

	it('gives every button type="button", so no control can submit a surrounding form', async () => {
		await mountDialog()

		const types = Array.from(find('.pdf-page-selection').closest('[role=dialog]').querySelectorAll('button')).map((element) => element.getAttribute('type'))
		expect(types.length).toBeGreaterThan(0)
		expect(types.every((value) => value === 'button')).toBe(true)
	})

	it('submits all pages', async () => {
		await mountDialog()

		await click(radio('all'))
		await click(button('Import'))

		expect(wrapper.emitted('submit')).toEqual([[{ start: 1, end: 5 }]])
	})

	it('submits a valid range and blocks an invalid one with an error', async () => {
		await mountDialog()
		await click(radio('range'))
		const [startInput, endInput] = document.body.querySelectorAll('.pdf-page-selection__range input')

		await type(startInput, 4)
		await type(endInput, 2)
		expect(find('.pdf-page-selection__hint').textContent).toContain('End page must be between 4 and 5.')
		expect(button('Import').disabled).toBe(true)

		await type(endInput, 5)
		await click(button('Import'))
		expect(wrapper.emitted('submit')).toEqual([[{ start: 4, end: 5 }]])
	})

	it(`offers no "All pages" above ${MAX_PDF_PAGES} pages and rejects a longer range`, async () => {
		const numPages = MAX_PDF_PAGES + 10
		await mountDialog({ numPages })

		expect(radio('all').disabled).toBe(true)
		await click(radio('range'))
		const [, endInput] = document.body.querySelectorAll('.pdf-page-selection__range input')
		await type(endInput, numPages)

		expect(button('Import').disabled).toBe(true)
		expect(document.body.textContent).toContain(`You can import at most ${MAX_PDF_PAGES} pages at once (selected: ${numPages}).`)
	})

	it('shows only the latest preview when an earlier one resolves last', async () => {
		const pending = new Map()
		const renderPreview = vi.fn((pageNumber) => new Promise((resolve) => pending.set(pageNumber, resolve)))
		await mountDialog({ renderPreview })

		await click(button('Next page'))
		pending.get(2)('data:image/png;base64,page2')
		pending.get(1)('data:image/png;base64,page1')
		await flushPromises()

		expect(find('.pdf-page-selection__preview').getAttribute('src')).toBe('data:image/png;base64,page2')
	})

	it('shows a note instead of failing when a preview cannot be rendered', async () => {
		await mountDialog({ renderPreview: vi.fn().mockRejectedValue(new Error('broken page')) })

		expect(document.body.textContent).toContain('Preview unavailable for this page.')
		await click(button('Import'))
		expect(wrapper.emitted('submit')).toEqual([[{ start: 1, end: 1 }]])
	})

	async function pressEscape(element) {
		element.focus()
		const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
		element.dispatchEvent(event)
		await flushPromises()
		return event
	}

	it('cancels on Escape from the page number field, which has the focus when the dialog opens', async () => {
		await mountDialog()
		const reachedDocument = vi.fn()
		document.addEventListener('keydown', reachedDocument)

		const event = await pressEscape(find('.pdf-page-selection__nav-input input'))
		document.removeEventListener('keydown', reachedDocument)

		expect(wrapper.emitted('cancel')).toHaveLength(1)
		expect(wrapper.emitted('submit')).toBeUndefined()
		// Excalidraw listens on document and must not also react to it.
		expect(event.defaultPrevented).toBe(true)
		expect(reachedDocument).not.toHaveBeenCalled()
	})

	it('cancels once on Escape from a button, which NcModal also handles', async () => {
		await mountDialog()

		await pressEscape(button('Next page'))
		// NcModal reports its own close after the closing animation.
		await new Promise((resolve) => setTimeout(resolve, 500))

		expect(wrapper.emitted('cancel')).toHaveLength(1)
		expect(wrapper.emitted('submit')).toBeUndefined()
	})

	it('cancels on Escape from a page range field', async () => {
		await mountDialog()
		await click(radio('range'))

		await pressEscape(find('.pdf-page-selection__range input'))

		expect(wrapper.emitted('cancel')).toHaveLength(1)
		expect(wrapper.emitted('submit')).toBeUndefined()
	})

	it('emits cancel when closed', async () => {
		await mountDialog()

		await click(button('Close'))

		// NcModal reports the close after its closing animation.
		await vi.waitFor(() => expect(wrapper.emitted('cancel')).toHaveLength(1))
		expect(wrapper.emitted('submit')).toBeUndefined()
	})
})
