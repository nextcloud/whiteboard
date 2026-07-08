/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const readSource = (path) => readFileSync(resolve(root, path), 'utf8')

describe('Vue 3 migration guardrails', () => {
	it('cleans up viewer roots hosted by Vue 2 or Vue 3', () => {
		const source = readSource('src/main.ts')
		expect(source).toContain('beforeDestroy(this: WhiteboardComponentInstance)')
		expect(source).toContain('beforeUnmount(this: WhiteboardComponentInstance)')
		expect(source.match(/unmountWhiteboardRoot\(this\)/g)).toHaveLength(2)
	})

	it('keeps form dialogs open on backdrop clicks', () => {
		for (const path of [
			'src/components/AssistantDialog.vue',
			'src/components/TableEditorDialog.vue',
		]) {
			const source = readSource(path)
			expect(source).not.toContain('close-on-click-outside')
		}
	})

	it('cleans up Excalidraw pointer listeners', () => {
		for (const path of ['src/hooks/useFiles.ts', 'src/hooks/useTableInsertion.tsx']) {
			const source = readSource(path)
			expect(source).toContain('const unsubscribePointerDown = excalidrawAPI.onPointerDown(')
			expect(source).toContain('unsubscribePointerDown()')
		}
	})

	it('imports React functions used by TSX components', () => {
		const embeddableSource = readSource('src/components/Embeddable.tsx')
		expect(embeddableSource).toContain("import { createElement } from 'react'")
		expect(embeddableSource).not.toContain('React.createElement')

		const wrapperSource = readSource('src/components/VueWrapper.tsx')
		expect(wrapperSource).toContain("import { useEffect, useRef } from 'react'")
		expect(wrapperSource).not.toContain('React.use')
	})

	it('passes the full Nextcloud emoji object into the loader', () => {
		const source = readSource('src/hooks/useEmojiPicker.tsx')
		expect(source).toContain('selected: (emoji: EmojiObj) => loadToExcalidraw(emoji)')
	})
})
