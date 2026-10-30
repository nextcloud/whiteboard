import { describe, expect, it } from 'vitest'
import { normalizeMermaidCode } from '../../src/utils/normalizeMermaidCode.ts'

describe('Mermaid code fence normalization', () => {
	const diagram = 'flowchart TD\n    A[Start] --> B[End]'

	it('removes Markdown code fences from Mermaid', () => {
		const response = '```mermaid\n' + diagram + '\n```'

		expect(normalizeMermaidCode(response)).toBe(diagram)
	})

	it('preserves Mermaid without code fences', () => {
		expect(normalizeMermaidCode(diagram)).toBe(diagram)
	})

	it('supports Windows-style line endings', () => {
		const response = '```mermaid\r\nflowchart TD\r\n    A --> B\r\n```'

		expect(normalizeMermaidCode(response))
			.toBe('flowchart TD\r\n    A --> B')
	})

	it('preserves incomplete code fences', () => {
		const response = '```mermaid\n' + diagram

		expect(normalizeMermaidCode(response)).toBe(response)
	})
})
